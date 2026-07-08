
require('dotenv').config();
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!GEMINI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Ada variabel .env yang belum diisi. Cek GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

function buildPrompt(answers) {
  return `Saya sedang membangun sistem automation konten Threads berbasis n8n + Supabase. Setiap "pillar" konten butuh 2 hal yang harus diisi ke database: (1) deskripsi persona, dan (2) jadwal angle harian.

STRUKTUR YANG DIBUTUHKAN (jawab HANYA dengan JSON valid, tanpa teks lain, tanpa markdown code fence):

{
  "persona_pillar": {
    "pillar_name": "slug_singkat",
    "persona_text": "deskripsi naratif 3-5 kalimat",
    "tone_rules": "aturan gaya bahasa sebagai poin-poin (pisah antar poin dengan \\n)",
    "style_examples": "3 contoh tulisan singkat yang mencerminkan gaya ini (pisah antar contoh dengan \\n\\n)"
  },
  "angle_schedule": [
    { "day_of_week": "senin", "time_slot": "08:00", "angle": "serius" },
    ... total HARUS 21 baris (7 hari x 3 slot: 08:00, 12:00, 16:00)
  ]
}

ATURAN ANGLE:
- "serius": insight/edukasi dari sudut pandang pillar ini, profesional tapi personal
- "lucu": humor ringan terkait topik pillar ini, tetap sopan
- "horror": cerita/pengalaman menegangkan yang DIKONTEKSTUALISASIKAN ke bidang pillar ini (bukan horror generik)
- "qna": pertanyaan terbuka ke followers — WAJIB dipakai persis 1x, di sabtu jam 16:00
- "rekap": refleksi mingguan personal — WAJIB dipakai persis 1x, di minggu jam 08:00

ATURAN JADWAL:
- Total harus 21 baris, day_of_week lowercase (senin..minggu), time_slot salah satu dari "08:00"/"12:00"/"16:00"
- Setiap hari punya persis 3 baris
- Jangan taruh angle yang sama 2x berturut-turut di hari yang sama
- Sabtu 16:00 = qna (wajib), Minggu 08:00 = rekap (wajib), sisanya (19 baris) dibagi rata antara serius/lucu/horror

DATA PILLAR BARU:
- Nama pillar (slug): ${answers.slug}
- Deskripsi persona: ${answers.deskripsi}
- Gaya bahasa: ${answers.gaya}
- Larangan spesifik: ${answers.larangan}
- Contoh topik/pengalaman relevan: ${answers.contohTopik}

Ingat: jawab HANYA JSON valid sesuai struktur di atas, tanpa penjelasan tambahan apapun.`;
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 1,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  const textBlock = candidate?.content?.parts?.find((p) => p.text)?.text;

  if (!textBlock) throw new Error('Tidak ada respons teks dari Gemini.');

  let cleaned = textBlock.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```\s*$/i, '');

  return JSON.parse(cleaned);
}

function validateResult(result) {
  if (!result.persona_pillar || !result.angle_schedule) {
    throw new Error('Struktur hasil tidak lengkap (persona_pillar / angle_schedule hilang).');
  }
  if (!Array.isArray(result.angle_schedule) || result.angle_schedule.length !== 21) {
    throw new Error(`angle_schedule harus 21 baris, dapat: ${result.angle_schedule?.length}`);
  }
  const validDays = ['senin', 'selasa', 'rabu', 'kamis', 'jumat', 'sabtu', 'minggu'];
  const validSlots = ['08:00', '12:00', '16:00'];
  const validAngles = ['serius', 'lucu', 'horror', 'qna', 'rekap'];

  for (const row of result.angle_schedule) {
    if (!validDays.includes(row.day_of_week)) throw new Error(`day_of_week tidak valid: ${row.day_of_week}`);
    if (!validSlots.includes(row.time_slot)) throw new Error(`time_slot tidak valid: ${row.time_slot}`);
    if (!validAngles.includes(row.angle)) throw new Error(`angle tidak valid: ${row.angle}`);
  }

  const sabtu16 = result.angle_schedule.find((r) => r.day_of_week === 'sabtu' && r.time_slot === '16:00');
  const minggu08 = result.angle_schedule.find((r) => r.day_of_week === 'minggu' && r.time_slot === '08:00');
  if (sabtu16?.angle !== 'qna') throw new Error('Sabtu 16:00 harus angle "qna".');
  if (minggu08?.angle !== 'rekap') throw new Error('Minggu 08:00 harus angle "rekap".');
}

async function insertToSupabase(pillarName, result) {
  console.log('\n📤 Insert ke tabel persona_pillar...');
  const { error: personaError } = await supabase
    .from('persona_pillar')
    .insert([{ ...result.persona_pillar, pillar_name: pillarName }]);

  if (personaError) throw new Error(`Gagal insert persona_pillar: ${personaError.message}`);
  console.log('✅ persona_pillar berhasil diinsert.');

  console.log('📤 Insert ke tabel angle_schedule (21 baris)...');
  const rows = result.angle_schedule.map((r) => ({ ...r, pillar_name: pillarName }));
  const { error: scheduleError } = await supabase.from('angle_schedule').insert(rows);

  if (scheduleError) throw new Error(`Gagal insert angle_schedule: ${scheduleError.message}`);
  console.log('✅ angle_schedule berhasil diinsert (21 baris).');
}

async function main() {
  console.log('=== Tambah Pillar Baru — Automation Threads ===\n');

  const slug = await ask('Nama pillar (slug, contoh: ai_teknologi): ');
  const deskripsi = await ask('Deskripsi persona (siapa suara akun, fokus apa, apa yang tidak boleh dicampur): ');
  const gaya = await ask('Gaya bahasa yang diinginkan: ');
  const larangan = await ask('Larangan spesifik (pisah dengan koma): ');
  const contohTopik = await ask('Contoh topik/pengalaman relevan (pisah dengan koma): ');

  rl.close();

  const { data: existing, error: checkError } = await supabase
    .from('persona_pillar')
    .select('pillar_name')
    .eq('pillar_name', slug.trim());

  if (checkError) {
    console.error('❌ Gagal cek data existing:', checkError.message);
    process.exit(1);
  }
  if (existing && existing.length > 0) {
    console.error(`❌ Pillar "${slug.trim()}" sudah ada di database. Batal, tidak ada yang diinsert.`);
    process.exit(1);
  }

  console.log('\n🤖 Meminta Gemini menyusun persona + jadwal...');
  const prompt = buildPrompt({ slug: slug.trim(), deskripsi, gaya, larangan, contohTopik });

  let result;
  try {
    result = await callGemini(prompt);
    validateResult(result);
  } catch (err) {
    console.error('❌ Gagal generate atau validasi hasil:', err.message);
    console.error('Tidak ada yang diinsert ke database. Coba jalankan ulang.');
    process.exit(1);
  }

  console.log('\n--- Preview hasil ---');
  console.log('Persona:', result.persona_pillar.persona_text);
  console.log('\nTone rules:', result.persona_pillar.tone_rules);
  console.log('\nStyle examples:', result.persona_pillar.style_examples);
  console.log('\nJumlah baris jadwal:', result.angle_schedule.length);
  console.log('\nJadwal:');
  console.table(result.angle_schedule);

  const confirm = await new Promise((resolve) => {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl2.question('\nLanjut insert ke Supabase? (y/n): ', (ans) => {
      rl2.close();
      resolve(ans.trim().toLowerCase());
    });
  });

  if (confirm !== 'y') {
    console.log('Dibatalkan, tidak ada yang diinsert.');
    process.exit(0);
  }

  try {
    await insertToSupabase(slug.trim(), result);
    console.log('\n🎉 Selesai! Pillar baru sudah aktif dan akan otomatis ikut dipilih secara acak oleh sistem.');
  } catch (err) {
    console.error('❌ Gagal insert ke Supabase:', err.message);
    process.exit(1);
  }
}

main();
