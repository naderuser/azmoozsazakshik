/**
 * آزمون آنلاین درس هدیه‌های آسمانی
 * مدرسه شهید علیرضا دادخدایی سنگبند
 *
 * یک Cloudflare Worker کامل شامل:
 *  - صفحه آزمون دانش‌آموز (با سربرگ، فرم اطلاعات و سوال امنیتی)
 *  - پنل معلم (ساخت دانش‌آموز با UUID اختصاصی، طراحی سوال، مشاهده پاسخنامه‌ها)
 *  - دانلود خروجی Word با سربرگ و جدول‌کشی
 *
 * داده‌ها در Cloudflare KV (binding: EXAM_KV) ذخیره می‌شوند.
 */

const DEFAULT_META = {
  title: "آزمون نوبت دوم",
  subject: "درس هدیه‌های آسمانی",
  school: "مدرسه شهید علیرضا دادخدایی سنگبند",
};

const QUESTION_TYPES = {
  descriptive: "تشریحی",
  multiple: "چهارگزینه‌ای",
  truefalse: "صحیح / غلط",
  short: "کوتاه‌پاسخ",
};

/* ------------------------- ابزارهای کمکی ------------------------- */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function uuid() {
  return crypto.randomUUID();
}

function parseCookies(req) {
  const out = {};
  const c = req.headers.get("cookie") || "";
  c.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isTeacher(req, env) {
  const cookies = parseCookies(req);
  return cookies.t_auth && cookies.t_auth === (env.TEACHER_PASSWORD || "nader0933");
}

async function getMeta(env) {
  const raw = await env.EXAM_KV.get("meta");
  return raw ? { ...DEFAULT_META, ...JSON.parse(raw) } : { ...DEFAULT_META };
}

async function getQuestions(env) {
  const raw = await env.EXAM_KV.get("questions");
  return raw ? JSON.parse(raw) : [];
}

async function listStudents(env) {
  const out = [];
  let cursor;
  do {
    const res = await env.EXAM_KV.list({ prefix: "student:", cursor });
    for (const k of res.keys) {
      const v = await env.EXAM_KV.get(k.name);
      if (v) out.push(JSON.parse(v));
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

/* ------------------------- روتر اصلی ------------------------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // API
      if (path.startsWith("/api/")) return await handleApi(req, env, url, path);

      // صفحه آزمون دانش‌آموز: /s/{uuid}
      if (path.startsWith("/s/")) {
        const id = decodeURIComponent(path.slice(3));
        return await studentPage(env, id);
      }

      // پنل معلم
      if (path === "/teacher" || path === "/teacher/") {
        return html(teacherPage());
      }

      // صفحه اصلی
      if (path === "/") return html(landingPage());

      return html(notFoundPage(), 404);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};

/* ------------------------- API ------------------------- */

async function handleApi(req, env, url, path) {
  const method = req.method;

  /* --- معلم: ورود/خروج --- */
  if (path === "/api/teacher/login" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    if ((body.password || "") === (env.TEACHER_PASSWORD || "nader0933")) {
      const cookie = `t_auth=${encodeURIComponent(env.TEACHER_PASSWORD || "nader0933")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
      return json({ ok: true }, 200, { "set-cookie": cookie });
    }
    return json({ ok: false, error: "رمز عبور اشتباه است" }, 401);
  }

  if (path === "/api/teacher/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": "t_auth=; Path=/; Max-Age=0" });
  }

  if (path === "/api/teacher/state" && method === "GET") {
    return json({ ok: true, auth: isTeacher(req, env) });
  }

  /* --- آزمون دانش‌آموز (عمومی) --- */
  if (path.startsWith("/api/exam/")) {
    const rest = path.slice("/api/exam/".length);
    const parts = rest.split("/");
    const id = decodeURIComponent(parts[0] || "");
    const student = await env.EXAM_KV.get("student:" + id);
    if (!student) return json({ ok: false, error: "لینک نامعتبر است" }, 404);

    if (parts[1] === "submit" && method === "POST") {
      const existing = await env.EXAM_KV.get("submission:" + id);
      if (existing) return json({ ok: false, error: "این آزمون قبلاً ثبت شده است" }, 409);
      const body = await req.json().catch(() => ({}));
      const meta = await getMeta(env);
      const questions = await getQuestions(env);
      const submission = {
        uuid: id,
        student: {
          name: String(body.name || "").slice(0, 120),
          fatherName: String(body.fatherName || "").slice(0, 120),
          nationalId: String(body.nationalId || "").slice(0, 30),
        },
        answers: body.answers || {},
        meta,
        questionsSnapshot: questions,
        submittedAt: Date.now(),
      };
      await env.EXAM_KV.put("submission:" + id, JSON.stringify(submission));
      return json({ ok: true });
    }

    if (method === "GET") {
      const meta = await getMeta(env);
      const questions = await getQuestions(env);
      const submitted = !!(await env.EXAM_KV.get("submission:" + id));
      // پاسخ‌های صحیح را برای دانش‌آموز ارسال نمی‌کنیم
      const safeQuestions = questions.map((q) => ({
        id: q.id,
        type: q.type,
        text: q.text,
        score: q.score,
        options: q.options || [],
      }));
      const st = JSON.parse(student);
      return json({ ok: true, meta, questions: safeQuestions, submitted, label: st.label || "" });
    }
  }

  /* --- از این به بعد فقط معلم --- */
  if (path.startsWith("/api/teacher/")) {
    if (!isTeacher(req, env)) return json({ ok: false, error: "دسترسی غیرمجاز" }, 401);

    // دانش‌آموزان
    if (path === "/api/teacher/students" && method === "GET") {
      const students = await listStudents(env);
      const withStatus = [];
      for (const s of students) {
        const sub = await env.EXAM_KV.get("submission:" + s.uuid);
        withStatus.push({ ...s, submitted: !!sub });
      }
      return json({ ok: true, students: withStatus });
    }

    if (path === "/api/teacher/students" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = uuid();
      const rec = { uuid: id, label: String(body.label || "").slice(0, 120), createdAt: Date.now() };
      await env.EXAM_KV.put("student:" + id, JSON.stringify(rec));
      return json({ ok: true, student: rec });
    }

    if (path.startsWith("/api/teacher/students/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/teacher/students/".length));
      await env.EXAM_KV.delete("student:" + id);
      await env.EXAM_KV.delete("submission:" + id);
      return json({ ok: true });
    }

    // سوالات و سربرگ
    if (path === "/api/teacher/questions" && method === "GET") {
      return json({ ok: true, meta: await getMeta(env), questions: await getQuestions(env) });
    }

    if (path === "/api/teacher/questions" && method === "PUT") {
      const body = await req.json().catch(() => ({}));
      const questions = (Array.isArray(body.questions) ? body.questions : []).map((q, i) => ({
        id: q.id || uuid(),
        type: QUESTION_TYPES[q.type] ? q.type : "descriptive",
        text: String(q.text || ""),
        score: Number(q.score) || 0,
        options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : [],
        correct: q.correct == null ? "" : q.correct,
        order: i,
      }));
      await env.EXAM_KV.put("questions", JSON.stringify(questions));
      if (body.meta) {
        const meta = { ...DEFAULT_META, ...body.meta };
        await env.EXAM_KV.put("meta", JSON.stringify(meta));
      }
      return json({ ok: true });
    }

    // پاسخنامه‌ها
    if (path === "/api/teacher/submissions" && method === "GET") {
      const students = await listStudents(env);
      const out = [];
      for (const s of students) {
        const raw = await env.EXAM_KV.get("submission:" + s.uuid);
        if (raw) out.push(JSON.parse(raw));
      }
      out.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
      return json({ ok: true, submissions: out });
    }

    // دانلود Word
    if (path === "/api/teacher/word" && method === "GET") {
      const type = url.searchParams.get("type") || "questions";
      const meta = await getMeta(env);
      if (type === "answers") {
        const id = url.searchParams.get("uuid");
        const raw = await env.EXAM_KV.get("submission:" + id);
        if (!raw) return json({ ok: false, error: "پاسخنامه یافت نشد" }, 404);
        const sub = JSON.parse(raw);
        return wordResponse(answerSheetWord(sub), `پاسخنامه-${sub.student.name || id}.doc`);
      }
      // برگه آزمون (سوالات)
      const questions = await getQuestions(env);
      return wordResponse(examWord(meta, questions), "برگه-آزمون.doc");
    }
  }

  return json({ ok: false, error: "مسیر یافت نشد" }, 404);
}

/* ------------------------- خروجی Word ------------------------- */

function wordResponse(bodyHtml, filename) {
  const doc =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">` +
    `<head><meta charset="utf-8">` +
    `<style>
      @page { size: A4; margin: 2cm; }
      body { font-family: 'B Nazanin','Tahoma',sans-serif; direction: rtl; font-size: 13pt; }
      .hdr { text-align:center; border-bottom: 2px solid #000; padding-bottom:8px; margin-bottom:14px; }
      .hdr h1 { font-size: 15pt; margin: 2px 0; }
      .hdr h2 { font-size: 13pt; margin: 2px 0; font-weight: normal; }
      .meta-table { width:100%; border-collapse: collapse; margin-bottom: 14px; }
      .meta-table td { border: 1px solid #000; padding: 6px 8px; }
      table.q { width:100%; border-collapse: collapse; margin-bottom: 10px; }
      table.q td, table.q th { border: 1px solid #000; padding: 6px 8px; vertical-align: top; }
      .qnum { width: 36px; text-align:center; font-weight:bold; }
      .opt { padding: 2px 18px; }
      .ans { min-height: 40px; }
    </style></head><body dir="rtl">` +
    bodyHtml +
    `</body></html>`;
  return new Response(doc, {
    headers: {
      "content-type": "application/msword; charset=utf-8",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}

function wordHeader(meta, extra = "") {
  return (
    `<div class="hdr">` +
    `<h1>${esc(meta.title)} - ${esc(meta.subject)}</h1>` +
    `<h2>${esc(meta.school)}</h2>` +
    `</div>` +
    extra
  );
}

function examWord(meta, questions) {
  let body = wordHeader(meta);
  body +=
    `<table class="meta-table"><tr>` +
    `<td>نام و نام خانوادگی: ...........................</td>` +
    `<td>نام پدر: ...........................</td>` +
    `<td>کد ملی: ...........................</td>` +
    `</tr></table>`;

  questions.forEach((q, i) => {
    let inner = `<div><b>${esc(q.text)}</b>` + (q.score ? ` <span>(${esc(q.score)} نمره)</span>` : "") + `</div>`;
    if (q.type === "multiple") {
      (q.options || []).forEach((o, oi) => {
        inner += `<div class="opt">${["الف", "ب", "ج", "د"][oi] || oi + 1}) ${esc(o)}</div>`;
      });
    } else if (q.type === "truefalse") {
      inner += `<div class="opt">صحیح ☐&nbsp;&nbsp;&nbsp; غلط ☐</div>`;
    } else if (q.type === "short") {
      inner += `<div class="ans">پاسخ: ...........................................................</div>`;
    } else {
      inner += `<div class="ans">پاسخ:<br><br><br></div>`;
    }
    body +=
      `<table class="q"><tr>` +
      `<td class="qnum">${i + 1}</td>` +
      `<td>${inner}</td>` +
      `</tr></table>`;
  });
  return body;
}

function answerLabel(q, ans) {
  if (q.type === "multiple") {
    const idx = Number(ans);
    if (!isNaN(idx) && q.options && q.options[idx] != null) {
      return `${["الف", "ب", "ج", "د"][idx] || idx + 1}) ${esc(q.options[idx])}`;
    }
    return esc(ans);
  }
  if (q.type === "truefalse") {
    if (ans === "true" || ans === true) return "صحیح";
    if (ans === "false" || ans === false) return "غلط";
    return esc(ans);
  }
  return esc(ans);
}

function answerSheetWord(sub) {
  const meta = sub.meta || DEFAULT_META;
  const questions = sub.questionsSnapshot || [];
  let body = wordHeader(meta);
  body +=
    `<table class="meta-table"><tr>` +
    `<td>نام و نام خانوادگی: ${esc(sub.student.name)}</td>` +
    `<td>نام پدر: ${esc(sub.student.fatherName)}</td>` +
    `<td>کد ملی: ${esc(sub.student.nationalId)}</td>` +
    `</tr><tr><td colspan="3">تاریخ ثبت: ${esc(new Date(sub.submittedAt).toLocaleString("fa-IR"))}</td></tr></table>`;

  body += `<table class="q"><tr><th class="qnum">ردیف</th><th>سوال</th><th>پاسخ دانش‌آموز</th></tr>`;
  questions.forEach((q, i) => {
    const ans = sub.answers ? sub.answers[q.id] : "";
    body +=
      `<tr><td class="qnum">${i + 1}</td>` +
      `<td>${esc(q.text)} <small>(${esc(QUESTION_TYPES[q.type] || q.type)})</small></td>` +
      `<td>${ans == null || ans === "" ? "<i>بدون پاسخ</i>" : answerLabel(q, ans)}</td></tr>`;
  });
  body += `</table>`;
  return body;
}

/* ------------------------- استایل مشترک صفحات ------------------------- */

const SHARED_CSS = `
  :root{--bg:#0f172a;--card:#ffffff;--primary:#1d4ed8;--primary-2:#2563eb;--accent:#0d9488;--muted:#64748b;--line:#e2e8f0;--danger:#dc2626;}
  *{box-sizing:border-box}
  body{margin:0;font-family:'Vazirmatn',Tahoma,system-ui,sans-serif;background:linear-gradient(180deg,#eef2ff,#f8fafc);color:#0f172a;direction:rtl;}
  .wrap{max-width:880px;margin:0 auto;padding:18px;}
  .header{background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;border-radius:18px;padding:22px;text-align:center;box-shadow:0 10px 30px rgba(37,99,235,.25);}
  .header h1{margin:4px 0;font-size:22px}
  .header h2{margin:4px 0;font-size:16px;font-weight:500;opacity:.95}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-top:16px;box-shadow:0 4px 16px rgba(15,23,42,.06)}
  label{display:block;font-size:14px;margin:10px 0 6px;font-weight:600}
  input,textarea,select{width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-family:inherit;font-size:15px;background:#fff}
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--primary-2);box-shadow:0 0 0 3px rgba(37,99,235,.15)}
  textarea{min-height:90px;resize:vertical}
  .btn{display:inline-block;background:var(--primary);color:#fff;border:none;padding:11px 18px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit}
  .btn:hover{background:var(--primary-2)}
  .btn.sec{background:#0d9488}.btn.sec:hover{background:#0f766e}
  .btn.gray{background:#475569}.btn.gray:hover{background:#334155}
  .btn.danger{background:var(--danger)}
  .btn.sm{padding:6px 12px;font-size:13px}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .row>*{flex:1;min-width:160px}
  .muted{color:var(--muted);font-size:13px}
  .q-block{border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:12px;background:#fbfdff}
  .q-block .qhead{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}
  .badge{background:#e0e7ff;color:#3730a3;border-radius:999px;padding:2px 10px;font-size:12px}
  .opt-row{display:flex;gap:8px;align-items:center;margin-top:6px}
  .opt-row input[type=text]{flex:1}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th,td{border:1px solid var(--line);padding:8px;text-align:right;font-size:14px}
  th{background:#f1f5f9}
  .tabs{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
  .tab{padding:9px 16px;border-radius:10px;background:#e2e8f0;cursor:pointer;font-weight:600;font-size:14px}
  .tab.active{background:var(--primary);color:#fff}
  .hidden{display:none}
  .toast{position:fixed;bottom:18px;right:18px;background:#0f172a;color:#fff;padding:12px 18px;border-radius:10px;opacity:0;transition:.3s;z-index:50}
  .toast.show{opacity:1}
  .link-box{font-family:monospace;direction:ltr;text-align:left;background:#f1f5f9;border-radius:8px;padding:8px;font-size:12px;word-break:break-all}
  .pill{font-size:12px;padding:2px 8px;border-radius:999px}
  .pill.ok{background:#dcfce7;color:#166534}.pill.no{background:#fee2e2;color:#991b1b}
  a{color:var(--primary)}
`;

const FONT_LINK = `<link rel="preconnect" href="https://cdn.jsdelivr.net"><link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet">`;

/* ------------------------- صفحه اصلی ------------------------- */

function landingPage() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(DEFAULT_META.title)} - ${esc(DEFAULT_META.subject)}</title>
  ${FONT_LINK}<style>${SHARED_CSS}</style></head><body><div class="wrap">
  <div class="header"><h1>${esc(DEFAULT_META.title)} - ${esc(DEFAULT_META.subject)}</h1>
  <h2>${esc(DEFAULT_META.school)}</h2></div>
  <div class="card">
    <p>دانش‌آموز گرامی، برای شرکت در آزمون از <b>لینک اختصاصی</b> که معلم برای شما ارسال کرده استفاده کنید.</p>
    <p class="muted">هر دانش‌آموز یک لینک منحصربه‌فرد دارد.</p>
    <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
    <a class="btn" href="/teacher">ورود معلم</a>
  </div></div></body></html>`;
}

function notFoundPage() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  ${FONT_LINK}<style>${SHARED_CSS}</style></head><body><div class="wrap">
  <div class="card"><h2>صفحه یافت نشد</h2><a class="btn" href="/">بازگشت</a></div></div></body></html>`;
}

/* ------------------------- صفحه دانش‌آموز ------------------------- */

async function studentPage(env, id) {
  const student = await env.EXAM_KV.get("student:" + id);
  if (!student) {
    return html(
      `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">${FONT_LINK}<style>${SHARED_CSS}</style></head>
      <body><div class="wrap"><div class="card"><h2>لینک نامعتبر است</h2>
      <p class="muted">این لینک معتبر نیست یا حذف شده است. لطفاً با معلم خود تماس بگیرید.</p></div></div></body></html>`,
      404
    );
  }

  return html(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>آزمون</title>${FONT_LINK}<style>${SHARED_CSS}</style></head>
  <body><div class="wrap">
    <div class="header" id="hdr"><h1>...</h1><h2>...</h2></div>

    <!-- مرحله ۱: اطلاعات و سوال امنیتی -->
    <div class="card" id="step-info">
      <h3>اطلاعات دانش‌آموز</h3>
      <label>نام و نام خانوادگی *</label><input id="f-name" autocomplete="off">
      <label>نام پدر *</label><input id="f-father" autocomplete="off">
      <label>کد ملی *</label><input id="f-nid" inputmode="numeric" autocomplete="off">
      <label>سوال امنیتی: <span id="sec-q"></span> *</label><input id="f-sec" inputmode="numeric" autocomplete="off">
      <p class="muted" id="info-err" style="color:var(--danger)"></p>
      <button class="btn" id="btn-enter">ورود به آزمون</button>
    </div>

    <!-- مرحله ۲: سوالات -->
    <div class="card hidden" id="step-exam">
      <h3>سوالات آزمون</h3>
      <div id="questions"></div>
      <button class="btn sec" id="btn-submit" style="margin-top:16px">ثبت نهایی پاسخنامه</button>
    </div>

    <!-- مرحله ۳: پایان -->
    <div class="card hidden" id="step-done">
      <h2>پاسخنامه شما با موفقیت ثبت شد ✅</h2>
      <p class="muted">پاسخ‌های شما برای معلم ارسال شد. موفق باشید.</p>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const ID = ${JSON.stringify(id)};
    let DATA = null;
    const a = Math.floor(Math.random()*8)+2, b = Math.floor(Math.random()*8)+2;
    document.getElementById('sec-q').textContent = a + ' + ' + b + ' = ؟';

    function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}

    async function load(){
      const r = await fetch('/api/exam/'+encodeURIComponent(ID));
      const d = await r.json();
      if(!d.ok){document.body.innerHTML='<div class="wrap"><div class="card"><h2>'+d.error+'</h2></div></div>';return;}
      DATA = d;
      document.getElementById('hdr').innerHTML='<h1>'+esc(d.meta.title)+' - '+esc(d.meta.subject)+'</h1><h2>'+esc(d.meta.school)+'</h2>';
      if(d.submitted){
        document.getElementById('step-info').classList.add('hidden');
        document.getElementById('step-done').classList.remove('hidden');
      }
    }

    function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}

    function renderQuestions(){
      const box=document.getElementById('questions');
      if(!DATA.questions.length){box.innerHTML='<p class="muted">هنوز سوالی توسط معلم طراحی نشده است.</p>';return;}
      box.innerHTML = DATA.questions.map((q,i)=>{
        let body='';
        if(q.type==='multiple'){
          body=(q.options||[]).map((o,oi)=>'<div class="opt-row"><label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="'+oi+'" style="width:auto;margin-left:6px"> '+['الف','ب','ج','د'][oi]+') '+esc(o)+'</label></div>').join('');
        }else if(q.type==='truefalse'){
          body='<div class="opt-row"><label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="true" style="width:auto;margin-left:6px"> صحیح</label>&nbsp;&nbsp;<label style="font-weight:400;margin:0"><input type="radio" name="q_'+q.id+'" value="false" style="width:auto;margin-left:6px"> غلط</label></div>';
        }else if(q.type==='short'){
          body='<input type="text" data-q="'+q.id+'" autocomplete="off">';
        }else{
          body='<textarea data-q="'+q.id+'"></textarea>';
        }
        return '<div class="q-block"><div class="qhead"><b>'+(i+1)+'. '+esc(q.text)+'</b><span class="badge">'+typeLabel(q.type)+(q.score?' • '+q.score+' نمره':'')+'</span></div>'+body+'</div>';
      }).join('');
    }
    function typeLabel(t){return {descriptive:'تشریحی',multiple:'چهارگزینه‌ای',truefalse:'صحیح/غلط',short:'کوتاه‌پاسخ'}[t]||t;}

    document.getElementById('btn-enter').onclick=()=>{
      const name=document.getElementById('f-name').value.trim();
      const father=document.getElementById('f-father').value.trim();
      const nid=document.getElementById('f-nid').value.trim();
      const sec=document.getElementById('f-sec').value.trim();
      const err=document.getElementById('info-err');
      if(!name||!father||!nid){err.textContent='لطفاً همه فیلدها را پر کنید.';return;}
      if(parseInt(sec,10)!==a+b){err.textContent='پاسخ سوال امنیتی اشتباه است.';return;}
      err.textContent='';
      window._student={name,fatherName:father,nationalId:nid};
      document.getElementById('step-info').classList.add('hidden');
      document.getElementById('step-exam').classList.remove('hidden');
      renderQuestions();
    };

    document.getElementById('btn-submit').onclick=async()=>{
      const answers={};
      DATA.questions.forEach(q=>{
        if(q.type==='multiple'||q.type==='truefalse'){
          const sel=document.querySelector('input[name="q_'+q.id+'"]:checked');
          answers[q.id]=sel?sel.value:'';
        }else{
          const el=document.querySelector('[data-q="'+q.id+'"]');
          answers[q.id]=el?el.value:'';
        }
      });
      const btn=document.getElementById('btn-submit');btn.disabled=true;btn.textContent='در حال ثبت...';
      const r=await fetch('/api/exam/'+encodeURIComponent(ID)+'/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...window._student,answers})});
      const d=await r.json();
      if(d.ok){
        document.getElementById('step-exam').classList.add('hidden');
        document.getElementById('step-done').classList.remove('hidden');
      }else{toast(d.error||'خطا در ثبت');btn.disabled=false;btn.textContent='ثبت نهایی پاسخنامه';}
    };

    load();
  </script></body></html>`);
}

/* ------------------------- پنل معلم ------------------------- */

function teacherPage() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>پنل معلم</title>${FONT_LINK}<style>${SHARED_CSS}</style></head>
  <body><div class="wrap">
    <div class="header"><h1>پنل معلم</h1><h2>${esc(DEFAULT_META.subject)} - ${esc(DEFAULT_META.school)}</h2></div>

    <!-- ورود -->
    <div class="card" id="login">
      <h3>ورود</h3>
      <label>رمز عبور</label><input id="pass" type="password" autocomplete="current-password">
      <p class="muted" id="login-err" style="color:var(--danger)"></p>
      <button class="btn" id="btn-login">ورود</button>
    </div>

    <!-- داشبورد -->
    <div id="dash" class="hidden">
      <div class="tabs">
        <div class="tab active" data-tab="students">دانش‌آموزان و لینک‌ها</div>
        <div class="tab" data-tab="questions">طراحی سوالات</div>
        <div class="tab" data-tab="answers">پاسخنامه‌ها</div>
        <div style="flex:1"></div>
        <div class="tab" id="btn-logout" style="background:#fee2e2;color:#991b1b">خروج</div>
      </div>

      <!-- دانش‌آموزان -->
      <div class="card tab-content" id="tab-students">
        <h3>ساخت دانش‌آموز جدید</h3>
        <div class="row">
          <input id="new-label" placeholder="نام دانش‌آموز (اختیاری)">
          <button class="btn" id="btn-add-student" style="flex:0 0 auto">+ ساخت لینک اختصاصی</button>
        </div>
        <p class="muted">برای هر دانش‌آموز یک UUID و لینک جداگانه ساخته می‌شود.</p>
        <div id="students-list"></div>
      </div>

      <!-- سوالات -->
      <div class="card tab-content hidden" id="tab-questions">
        <h3>سربرگ آزمون</h3>
        <div class="row">
          <div><label>عنوان</label><input id="m-title"></div>
          <div><label>درس</label><input id="m-subject"></div>
        </div>
        <label>نام مدرسه</label><input id="m-school">
        <hr style="border:none;border-top:1px solid var(--line);margin:14px 0">
        <h3>سوالات</h3>
        <div id="q-list"></div>
        <div class="row" style="margin-top:12px">
          <button class="btn gray sm" data-add="descriptive" style="flex:0 0 auto">+ تشریحی</button>
          <button class="btn gray sm" data-add="multiple" style="flex:0 0 auto">+ چهارگزینه‌ای</button>
          <button class="btn gray sm" data-add="truefalse" style="flex:0 0 auto">+ صحیح/غلط</button>
          <button class="btn gray sm" data-add="short" style="flex:0 0 auto">+ کوتاه‌پاسخ</button>
        </div>
        <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" id="btn-save-q">ذخیره سوالات</button>
          <a class="btn sec" id="btn-word-exam" href="/api/teacher/word?type=questions">دانلود برگه آزمون (Word)</a>
        </div>
      </div>

      <!-- پاسخنامه‌ها -->
      <div class="card tab-content hidden" id="tab-answers">
        <h3>پاسخنامه‌های دریافتی</h3>
        <button class="btn gray sm" id="btn-refresh-ans">به‌روزرسانی</button>
        <div id="answers-list"></div>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>${teacherScript()}</script>
  </body></html>`;
}

function teacherScript() {
  // اسکریپت سمت کلاینت پنل معلم
  return `
  const TYPES={descriptive:'تشریحی',multiple:'چهارگزینه‌ای',truefalse:'صحیح/غلط',short:'کوتاه‌پاسخ'};
  let QUESTIONS=[], META={};
  function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
  function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
  function uid(){return 'q-'+Math.random().toString(36).slice(2,10);}

  async function api(path,opts){const r=await fetch(path,opts);return r.json();}

  // ---- ورود ----
  async function checkAuth(){const d=await api('/api/teacher/state');if(d.auth)showDash();}
  document.getElementById('btn-login').onclick=async()=>{
    const p=document.getElementById('pass').value;
    const d=await api('/api/teacher/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:p})});
    if(d.ok)showDash();else document.getElementById('login-err').textContent=d.error||'خطا';
  };
  document.getElementById('pass').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('btn-login').click();});
  document.getElementById('btn-logout').onclick=async()=>{await api('/api/teacher/logout',{method:'POST'});location.reload();};

  function showDash(){
    document.getElementById('login').classList.add('hidden');
    document.getElementById('dash').classList.remove('hidden');
    loadStudents();loadQuestions();
  }

  // ---- تب‌ها ----
  document.querySelectorAll('.tab[data-tab]').forEach(t=>t.onclick=()=>{
    document.querySelectorAll('.tab[data-tab]').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c=>c.classList.add('hidden'));
    document.getElementById('tab-'+t.dataset.tab).classList.remove('hidden');
    if(t.dataset.tab==='answers')loadAnswers();
  });

  // ---- دانش‌آموزان ----
  async function loadStudents(){
    const d=await api('/api/teacher/students');
    const box=document.getElementById('students-list');
    if(!d.students.length){box.innerHTML='<p class="muted">هنوز دانش‌آموزی ساخته نشده است.</p>';return;}
    box.innerHTML='<table><tr><th>#</th><th>نام</th><th>لینک اختصاصی</th><th>وضعیت</th><th></th></tr>'+
      d.students.map((s,i)=>{
        const link=location.origin+'/s/'+s.uuid;
        return '<tr><td>'+(i+1)+'</td><td>'+esc(s.label||'-')+'</td>'+
          '<td><div class="link-box">'+link+'</div></td>'+
          '<td>'+(s.submitted?'<span class="pill ok">ثبت شده</span>':'<span class="pill no">در انتظار</span>')+'</td>'+
          '<td><button class="btn sm" onclick="copyLink(\\''+link+'\\')">کپی</button> '+
          '<button class="btn sm danger" onclick="delStudent(\\''+s.uuid+'\\')">حذف</button></td></tr>';
      }).join('')+'</table>';
  }
  window.copyLink=(l)=>{navigator.clipboard.writeText(l).then(()=>toast('لینک کپی شد'));};
  window.delStudent=async(id)=>{if(!confirm('حذف این دانش‌آموز و پاسخنامه‌اش؟'))return;await api('/api/teacher/students/'+id,{method:'DELETE'});loadStudents();};
  document.getElementById('btn-add-student').onclick=async()=>{
    const label=document.getElementById('new-label').value.trim();
    await api('/api/teacher/students',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label})});
    document.getElementById('new-label').value='';loadStudents();toast('دانش‌آموز ساخته شد');
  };

  // ---- سوالات ----
  async function loadQuestions(){
    const d=await api('/api/teacher/questions');
    META=d.meta||{};QUESTIONS=d.questions||[];
    document.getElementById('m-title').value=META.title||'';
    document.getElementById('m-subject').value=META.subject||'';
    document.getElementById('m-school').value=META.school||'';
    renderQ();
  }
  function renderQ(){
    const box=document.getElementById('q-list');
    box.innerHTML=QUESTIONS.map((q,i)=>qBlock(q,i)).join('')||'<p class="muted">سوالی اضافه نشده است.</p>';
  }
  function qBlock(q,i){
    let body='<label>متن سوال</label><textarea oninput="upd('+i+',\\'text\\',this.value)">'+esc(q.text)+'</textarea>';
    body+='<div class="row"><div><label>نمره</label><input type="number" min="0" step="0.25" value="'+(q.score||0)+'" oninput="upd('+i+',\\'score\\',this.value)"></div>';
    if(q.type==='multiple'){
      body+='<div><label>گزینه صحیح</label><select onchange="upd('+i+',\\'correct\\',this.value)">'+
        [0,1,2,3].map(n=>'<option value="'+n+'" '+(String(q.correct)===String(n)?'selected':'')+'>'+['الف','ب','ج','د'][n]+'</option>').join('')+'</select></div></div>';
      body+='<label>گزینه‌ها</label>';
      for(let oi=0;oi<4;oi++){
        body+='<div class="opt-row"><span>'+['الف','ب','ج','د'][oi]+')</span><input type="text" value="'+esc((q.options&&q.options[oi])||'')+'" oninput="updOpt('+i+','+oi+',this.value)"></div>';
      }
    }else if(q.type==='truefalse'){
      body+='<div><label>پاسخ صحیح</label><select onchange="upd('+i+',\\'correct\\',this.value)">'+
        '<option value="true" '+(String(q.correct)==='true'?'selected':'')+'>صحیح</option>'+
        '<option value="false" '+(String(q.correct)==='false'?'selected':'')+'>غلط</option></select></div></div>';
    }else if(q.type==='short'){
      body+='<div><label>پاسخ نمونه (اختیاری)</label><input type="text" value="'+esc(q.correct||'')+'" oninput="upd('+i+',\\'correct\\',this.value)"></div></div>';
    }else{
      body+='</div>';
    }
    return '<div class="q-block"><div class="qhead"><b>سوال '+(i+1)+'</b>'+
      '<span><span class="badge">'+TYPES[q.type]+'</span> '+
      '<button class="btn sm gray" onclick="moveQ('+i+',-1)">▲</button>'+
      '<button class="btn sm gray" onclick="moveQ('+i+',1)">▼</button>'+
      '<button class="btn sm danger" onclick="delQ('+i+')">حذف</button></span></div>'+body+'</div>';
  }
  window.upd=(i,k,v)=>{QUESTIONS[i][k]=v;};
  window.updOpt=(i,oi,v)=>{QUESTIONS[i].options=QUESTIONS[i].options||[];QUESTIONS[i].options[oi]=v;};
  window.delQ=(i)=>{QUESTIONS.splice(i,1);renderQ();};
  window.moveQ=(i,dir)=>{const j=i+dir;if(j<0||j>=QUESTIONS.length)return;[QUESTIONS[i],QUESTIONS[j]]=[QUESTIONS[j],QUESTIONS[i]];renderQ();};
  document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{
    QUESTIONS.push({id:uid(),type:b.dataset.add,text:'',score:0,options:b.dataset.add==='multiple'?['','','',''] :[],correct:b.dataset.add==='multiple'?'0':(b.dataset.add==='truefalse'?'true':'')});
    renderQ();
  });
  document.getElementById('btn-save-q').onclick=async()=>{
    META={title:document.getElementById('m-title').value,subject:document.getElementById('m-subject').value,school:document.getElementById('m-school').value};
    const d=await api('/api/teacher/questions',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({questions:QUESTIONS,meta:META})});
    if(d.ok)toast('ذخیره شد');else toast(d.error||'خطا');
  };

  // ---- پاسخنامه‌ها ----
  async function loadAnswers(){
    const d=await api('/api/teacher/submissions');
    const box=document.getElementById('answers-list');
    if(!d.submissions.length){box.innerHTML='<p class="muted">هنوز پاسخنامه‌ای ثبت نشده است.</p>';return;}
    box.innerHTML=d.submissions.map(s=>{
      const rows=(s.questionsSnapshot||[]).map((q,i)=>{
        let ans=s.answers?s.answers[q.id]:'';
        if(q.type==='multiple'){const idx=parseInt(ans,10);ans=isNaN(idx)?'':(['الف','ب','ج','د'][idx]+') '+esc((q.options&&q.options[idx])||''));}
        else if(q.type==='truefalse'){ans=ans==='true'?'صحیح':(ans==='false'?'غلط':'');}
        else ans=esc(ans);
        return '<tr><td>'+(i+1)+'</td><td>'+esc(q.text)+'</td><td>'+(ans||'<i>بدون پاسخ</i>')+'</td></tr>';
      }).join('');
      return '<div class="q-block"><div class="qhead"><b>'+esc(s.student.name)+'</b>'+
        '<a class="btn sm sec" href="/api/teacher/word?type=answers&uuid='+s.uuid+'">دانلود Word</a></div>'+
        '<p class="muted">نام پدر: '+esc(s.student.fatherName)+' | کد ملی: '+esc(s.student.nationalId)+' | '+new Date(s.submittedAt).toLocaleString('fa-IR')+'</p>'+
        '<table><tr><th>#</th><th>سوال</th><th>پاسخ</th></tr>'+rows+'</table></div>';
    }).join('');
  }
  document.getElementById('btn-refresh-ans').onclick=loadAnswers;

  checkAuth();
  `;
}
