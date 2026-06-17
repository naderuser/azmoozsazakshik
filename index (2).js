/**
 * پنل آزمون ساز دوره ابتدایی
 * طراح: نادر اکشیک
 *
 * یک Cloudflare Worker کامل شامل:
 *  - صفحه آزمون دانش‌آموز (سربرگ، فرم اطلاعات، سوال امنیتی، نمایش نتیجه پس از تصحیح)
 *  - پنل معلم (ساخت دانش‌آموز با UUID اختصاصی، طراحی سوال، تصحیح و بازخورد، مشاهده پاسخنامه‌ها)
 *  - سوال تشریحی با امکان درج عکس، اشکال هندسی و علائم ریاضی
 *  - دانلود خروجی Word با سربرگ و جدول‌کشی
 *
 * داده‌ها در Cloudflare KV (binding: EXAM_KV) ذخیره می‌شوند.
 */

const APP_TITLE = "پنل آزمون ساز دوره ابتدایی";
const APP_DESIGNER = "طراح: نادر اکشیک";

const DEFAULT_META = {
  school: "",
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

// پاک‌سازی سبک محتوای HTML سوال تشریحی (محتوای معلم) برای جلوگیری از اسکریپت مخرب
function sanitizeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta|style)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
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

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getTeacherHash(env) {
  return await env.EXAM_KV.get("teacher_pass");
}

async function isTeacher(req, env) {
  const stored = await getTeacherHash(env);
  if (!stored) return false;
  const cookies = parseCookies(req);
  return Boolean(cookies.t_auth && cookies.t_auth === stored);
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
      if (path.startsWith("/api/")) return await handleApi(req, env, url, path);

      if (path.startsWith("/s/")) {
        const id = decodeURIComponent(path.slice(3));
        return await studentPage(env, id);
      }

      if (path === "/teacher" || path === "/teacher/") return html(teacherPage());

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
    const pass = String(body.password || "");
    const stored = await getTeacherHash(env);
    const cookieFor = (h) => `t_auth=${h}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
    if (!stored) {
      // اولین ورود: رمز عبور توسط معلم تعریف می‌شود (رمز پیش‌فرض وجود ندارد)
      if (pass.length < 4) return json({ ok: false, error: "رمز باید حداقل ۴ کاراکتر باشد" }, 400);
      const hash = await sha256(pass);
      await env.EXAM_KV.put("teacher_pass", hash);
      return json({ ok: true, created: true }, 200, { "set-cookie": cookieFor(hash) });
    }
    const hash = await sha256(pass);
    if (hash === stored) return json({ ok: true }, 200, { "set-cookie": cookieFor(hash) });
    return json({ ok: false, error: "رمز عبور اشتباه است" }, 401);
  }

  if (path === "/api/teacher/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": "t_auth=; Path=/; Max-Age=0" });
  }

  if (path === "/api/teacher/state" && method === "GET") {
    const stored = await getTeacherHash(env);
    return json({ ok: true, auth: await isTeacher(req, env), configured: Boolean(stored) });
  }

  /* --- آزمون دانش‌آموز (عمومی) --- */
  if (path.startsWith("/api/exam/")) {
    const rest = path.slice("/api/exam/".length);
    const parts = rest.split("/");
    const id = decodeURIComponent(parts[0] || "");
    const studentRaw = await env.EXAM_KV.get("student:" + id);
    if (!studentRaw) return json({ ok: false, error: "لینک نامعتبر است" }, 404);

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
          courseName: String(body.courseName || "").slice(0, 120),
          examDate: String(body.examDate || "").slice(0, 40),
        },
        answers: body.answers || {},
        meta,
        questionsSnapshot: questions,
        submittedAt: Date.now(),
        grading: null,
      };
      await env.EXAM_KV.put("submission:" + id, JSON.stringify(submission));
      return json({ ok: true });
    }

    if (method === "GET") {
      const meta = await getMeta(env);
      const subRaw = await env.EXAM_KV.get("submission:" + id);
      const st = JSON.parse(studentRaw);
      if (subRaw) {
        const sub = JSON.parse(subRaw);
        const resultQuestions = (sub.questionsSnapshot || []).map(safeQuestion);
        return json({
          ok: true,
          meta,
          submitted: true,
          result: {
            questions: resultQuestions,
            answers: sub.answers || {},
            student: sub.student || {},
            grading: sub.grading || null,
          },
        });
      }
      const questions = (await getQuestions(env)).map(safeQuestion);
      return json({ ok: true, meta, submitted: false, questions, label: st.label || "" });
    }
  }

  /* --- از این به بعد فقط معلم --- */
  if (path.startsWith("/api/teacher/")) {
    if (!(await isTeacher(req, env))) return json({ ok: false, error: "دسترسی غیرمجاز" }, 401);

    // تغییر رمز عبور معلم
    if (path === "/api/teacher/password" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const np = String(body.newPassword || "");
      if (np.length < 4) return json({ ok: false, error: "رمز جدید باید حداقل ۴ کاراکتر باشد" }, 400);
      const hash = await sha256(np);
      await env.EXAM_KV.put("teacher_pass", hash);
      return json({ ok: true }, 200, { "set-cookie": `t_auth=${hash}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400` });
    }

    // دانش‌آموزان
    if (path === "/api/teacher/students" && method === "GET") {
      const students = await listStudents(env);
      const withStatus = [];
      for (const s of students) {
        const subRaw = await env.EXAM_KV.get("submission:" + s.uuid);
        let status = "pending";
        if (subRaw) {
          const sub = JSON.parse(subRaw);
          status = sub.grading && sub.grading.graded ? "graded" : "submitted";
        }
        withStatus.push({ ...s, status });
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
      const questions = (Array.isArray(body.questions) ? body.questions : []).map((q, i) => {
        const type = QUESTION_TYPES[q.type] ? q.type : "descriptive";
        const rich = type === "descriptive" && Boolean(q.rich);
        return {
          id: q.id || uuid(),
          type,
          rich,
          text: rich ? sanitizeHtml(String(q.text || "")) : String(q.text || ""),
          options: Array.isArray(q.options) ? q.options.map((o) => String(o)) : [],
          correct: q.correct == null ? "" : q.correct,
          image: typeof q.image === "string" ? q.image : "",
          order: i,
        };
      });
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
        if (raw) {
          const sub = JSON.parse(raw);
          sub.label = s.label || "";
          out.push(sub);
        }
      }
      out.sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
      return json({ ok: true, submissions: out });
    }

    // ثبت تصحیح/بازخورد
    if (path === "/api/teacher/grade" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const id = body.uuid;
      const raw = await env.EXAM_KV.get("submission:" + id);
      if (!raw) return json({ ok: false, error: "پاسخنامه یافت نشد" }, 404);
      const sub = JSON.parse(raw);
      sub.grading = {
        graded: true,
        overall: String(body.overall || ""),
        feedback: body.feedback && typeof body.feedback === "object" ? body.feedback : {},
        marks: body.marks && typeof body.marks === "object" ? body.marks : {},
        gradedAt: Date.now(),
      };
      await env.EXAM_KV.put("submission:" + id, JSON.stringify(sub));
      return json({ ok: true });
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
      const questions = await getQuestions(env);
      return wordResponse(examWord(meta, questions), "برگه-آزمون.doc");
    }
  }

  return json({ ok: false, error: "مسیر یافت نشد" }, 404);
}

function safeQuestion(q) {
  // پاسخ صحیح را به دانش‌آموز ارسال نمی‌کنیم
  return { id: q.id, type: q.type, rich: Boolean(q.rich), text: q.text, options: q.options || [], image: q.image || "" };
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
      .hdr h2 { font-size: 12pt; margin: 2px 0; font-weight: normal; }
      .hdr h3 { font-size: 12pt; margin: 2px 0; font-weight: normal; }
      .meta-table { width:100%; border-collapse: collapse; margin-bottom: 14px; }
      .meta-table td { border: 1px solid #000; padding: 6px 8px; }
      table.q { width:100%; border-collapse: collapse; margin-bottom: 10px; }
      table.q td, table.q th { border: 1px solid #000; padding: 6px 8px; vertical-align: top; }
      .qnum { width: 36px; text-align:center; font-weight:bold; }
      .opt { padding: 2px 18px; }
      .ans { min-height: 40px; }
      img { max-width: 320px; }
      .frac{display:inline-block;text-align:center;vertical-align:middle;margin:0 3px}
      .frac .fn{display:block;border-bottom:1.5px solid #000;padding:0 4px}
      .frac .fd{display:block;padding:0 4px}
      .shape{display:inline-block;vertical-align:middle;line-height:1;margin:0 2px}
      .ldiv{display:inline-block;border-collapse:collapse;margin:6px 2px;vertical-align:top}
      .ldiv td{padding:2px 8px;vertical-align:top}
      .ldiv .divisor{border-right:1.5px solid #000}
      .ldiv .quotient{border-top:1.5px solid #000;border-right:1.5px solid #000}
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
  // سربرگ برگه‌ی آزمون فقط نام مدرسه‌ی خود معلم را نشان می‌دهد
  return (
    `<div class="hdr">` +
    `<h1>${esc(meta.school || "")}</h1>` +
    `</div>` +
    extra
  );
}

function questionBodyWord(q) {
  let inner = `<div><b>${q.rich ? q.text : esc(q.text)}</b></div>`;
  if (q.image) inner += `<div><img src="${esc(q.image)}"></div>`;
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
  return inner;
}

function examWord(meta, questions) {
  let body = wordHeader(meta);
  body +=
    `<table class="meta-table">` +
    `<tr><td>نام و نام خانوادگی: ...................</td><td>نام پدر: ...................</td><td>کد ملی: ...................</td></tr>` +
    `<tr><td>نام درس: ...................</td><td>تاریخ آزمون: ...................</td><td>کلاس: ...................</td></tr>` +
    `</table>`;

  questions.forEach((q, i) => {
    body +=
      `<table class="q"><tr>` +
      `<td class="qnum">${i + 1}</td>` +
      `<td>${questionBodyWord(q)}</td>` +
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

const MARK_LABEL = { correct: "صحیح", wrong: "غلط", partial: "نیمه‌درست" };

function answerSheetWord(sub) {
  const meta = sub.meta || DEFAULT_META;
  const questions = sub.questionsSnapshot || [];
  const g = sub.grading || {};
  const st = sub.student || {};
  let body = wordHeader(meta);
  body +=
    `<table class="meta-table">` +
    `<tr><td>نام و نام خانوادگی: ${esc(st.name)}</td><td>نام پدر: ${esc(st.fatherName)}</td><td>کد ملی: ${esc(st.nationalId)}</td></tr>` +
    `<tr><td>نام درس: ${esc(st.courseName)}</td><td>تاریخ آزمون: ${esc(st.examDate)}</td><td>تاریخ ثبت: ${esc(new Date(sub.submittedAt).toLocaleString("fa-IR"))}</td></tr>` +
    `</table>`;

  body += `<table class="q"><tr><th class="qnum">ردیف</th><th>سوال</th><th>پاسخ دانش‌آموز</th><th>وضعیت</th><th>بازخورد معلم</th></tr>`;
  questions.forEach((q, i) => {
    const ans = sub.answers ? sub.answers[q.id] : "";
    const mark = g.marks ? g.marks[q.id] : "";
    const fb = g.feedback ? g.feedback[q.id] : "";
    let qcell = q.rich ? q.text : esc(q.text);
    if (q.image) qcell += `<div><img src="${esc(q.image)}"></div>`;
    body +=
      `<tr><td class="qnum">${i + 1}</td>` +
      `<td>${qcell} <small>(${esc(QUESTION_TYPES[q.type] || q.type)})</small></td>` +
      `<td>${ans == null || ans === "" ? "<i>بدون پاسخ</i>" : answerLabel(q, ans)}</td>` +
      `<td>${esc(MARK_LABEL[mark] || "")}</td>` +
      `<td>${esc(fb || "")}</td></tr>`;
  });
  body += `</table>`;
  if (g.overall) body += `<p><b>نتیجه/بازخورد کلی:</b> ${esc(g.overall)}</p>`;
  return body;
}

/* ------------------------- استایل مشترک صفحات ------------------------- */

const SHARED_CSS = `
  :root{--bg:#0f172a;--card:#ffffff;--primary:#1d4ed8;--primary-2:#2563eb;--accent:#0d9488;--muted:#64748b;--line:#e2e8f0;--danger:#dc2626;}
  *{box-sizing:border-box}
  body{margin:0;font-family:'Vazirmatn',Tahoma,system-ui,sans-serif;background:linear-gradient(180deg,#eef2ff,#f8fafc);color:#0f172a;direction:rtl;}
  .wrap{max-width:920px;margin:0 auto;padding:18px;}
  .header{background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;border-radius:18px;padding:22px;text-align:center;box-shadow:0 10px 30px rgba(37,99,235,.25);}
  .header h1{margin:4px 0;font-size:22px}
  .header h2{margin:4px 0;font-size:15px;font-weight:500;opacity:.95}
  .header h3{margin:4px 0;font-size:13px;font-weight:400;opacity:.9}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-top:16px;box-shadow:0 4px 16px rgba(15,23,42,.06)}
  label{display:block;font-size:14px;margin:10px 0 6px;font-weight:600}
  input,textarea,select{width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:10px;font-family:inherit;font-size:15px;background:#fff}
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--primary-2);box-shadow:0 0 0 3px rgba(37,99,235,.15)}
  textarea{min-height:90px;resize:vertical}
  .btn{display:inline-block;background:var(--primary);color:#fff;border:none;padding:11px 18px;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;text-decoration:none}
  .btn:hover{background:var(--primary-2)}
  .btn.sec{background:#0d9488}.btn.sec:hover{background:#0f766e}
  .btn.gray{background:#475569}.btn.gray:hover{background:#334155}
  .btn.danger{background:var(--danger)}
  .btn.sm{padding:6px 12px;font-size:13px}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .row>*{flex:1;min-width:160px}
  .muted{color:var(--muted);font-size:13px}
  .q-block{border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:12px;background:#fbfdff}
  .q-block .qhead{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
  .badge{background:#e0e7ff;color:#3730a3;border-radius:999px;padding:2px 10px;font-size:12px}
  .opt-row{display:flex;gap:8px;align-items:center;margin-top:6px}
  .opt-row input[type=text]{flex:1}
  .toolbar{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}
  .toolbar button{background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:4px 9px;cursor:pointer;font-size:15px;min-width:32px}
  .toolbar button:hover{background:#c7d2fe}
  .toolbar .grp-label{font-size:12px;color:var(--muted);align-self:center;margin-left:6px}
  .imgprev{max-width:220px;max-height:160px;border:1px solid var(--line);border-radius:8px;margin-top:6px;display:block}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th,td{border:1px solid var(--line);padding:8px;text-align:right;font-size:14px;vertical-align:top}
  th{background:#f1f5f9}
  .tabs{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
  .tab{padding:9px 16px;border-radius:10px;background:#e2e8f0;cursor:pointer;font-weight:600;font-size:14px}
  .tab.active{background:var(--primary);color:#fff}
  .hidden{display:none}
  .toast{position:fixed;bottom:18px;right:18px;background:#0f172a;color:#fff;padding:12px 18px;border-radius:10px;opacity:0;transition:.3s;z-index:50}
  .toast.show{opacity:1}
  .link-box{font-family:monospace;direction:ltr;text-align:left;background:#f1f5f9;border-radius:8px;padding:8px;font-size:12px;word-break:break-all}
  .pill{font-size:12px;padding:2px 8px;border-radius:999px}
  .pill.ok{background:#dcfce7;color:#166534}.pill.no{background:#fee2e2;color:#991b1b}.pill.gr{background:#dbeafe;color:#1e40af}
  .mark.correct{color:#166534;font-weight:700}.mark.wrong{color:#991b1b;font-weight:700}.mark.partial{color:#92400e;font-weight:700}
  a{color:var(--primary)}
  .rich{min-height:90px;border:1px solid #cbd5e1;border-radius:10px;padding:11px 12px;background:#fff;font-size:15px;line-height:1.9}
  .rich:focus{outline:none;border-color:var(--primary-2);box-shadow:0 0 0 3px rgba(37,99,235,.15)}
  .frac{display:inline-flex;flex-direction:column;text-align:center;vertical-align:middle;margin:0 3px;line-height:1.05}
  .frac .fn{display:block;border-bottom:2px solid currentColor;padding:0 5px}
  .frac .fd{display:block;padding:0 5px}
  .shape{display:inline-block;vertical-align:middle;line-height:1;margin:0 2px}
  .shape svg{display:block}
  .ldiv{display:inline-block;border-collapse:collapse;margin:6px 2px;vertical-align:top}
  .ldiv td{border:none;padding:2px 8px;font-size:15px;vertical-align:top}
  .ldiv .divisor{border-right:2px solid currentColor}
  .ldiv .quotient{border-top:2px solid currentColor;border-right:2px solid currentColor}
`;

const FONT_LINK = `<link rel="preconnect" href="https://cdn.jsdelivr.net"><link href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" rel="stylesheet">`;

function pageHeader() {
  return `<div class="header"><h1>${esc(APP_TITLE)}</h1><h2>${esc(APP_DESIGNER)}</h2></div>`;
}

/* ------------------------- صفحه اصلی ------------------------- */

function landingPage() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(APP_TITLE)}</title>
  ${FONT_LINK}<style>${SHARED_CSS}</style></head><body><div class="wrap">
  ${pageHeader()}
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
  ${pageHeader()}<div class="card"><h2>صفحه یافت نشد</h2><a class="btn" href="/">بازگشت</a></div></div></body></html>`;
}

/* ------------------------- صفحه دانش‌آموز ------------------------- */

async function studentPage(env, id) {
  const student = await env.EXAM_KV.get("student:" + id);
  if (!student) {
    return html(
      `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">${FONT_LINK}<style>${SHARED_CSS}</style></head>
      <body><div class="wrap">${pageHeader()}<div class="card"><h2>لینک نامعتبر است</h2>
      <p class="muted">این لینک معتبر نیست یا حذف شده است. لطفاً با معلم خود تماس بگیرید.</p></div></div></body></html>`,
      404
    );
  }

  return html(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>آزمون</title>${FONT_LINK}<style>${SHARED_CSS}</style></head>
  <body><div class="wrap">
    ${pageHeader()}
    <div class="card" id="hdr2"></div>

    <!-- مرحله ۱: اطلاعات و سوال امنیتی -->
    <div class="card hidden" id="step-info">
      <h3>اطلاعات دانش‌آموز</h3>
      <div class="row">
        <div><label>نام و نام خانوادگی *</label><input id="f-name" autocomplete="off"></div>
        <div><label>نام پدر *</label><input id="f-father" autocomplete="off"></div>
      </div>
      <div class="row">
        <div><label>کد ملی *</label><input id="f-nid" inputmode="numeric" autocomplete="off"></div>
        <div><label>نام درس *</label><input id="f-course" autocomplete="off"></div>
        <div><label>تاریخ آزمون *</label><input id="f-date" autocomplete="off"></div>
      </div>
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

    <!-- مرحله ۳: نتیجه -->
    <div class="card hidden" id="step-done"></div>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const ID = ${JSON.stringify(id)};
    let DATA = null;
    const a = Math.floor(Math.random()*8)+2, b = Math.floor(Math.random()*8)+2;

    function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
    function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
    function typeLabel(t){return {descriptive:'تشریحی',multiple:'چهارگزینه‌ای',truefalse:'صحیح/غلط',short:'کوتاه‌پاسخ'}[t]||t;}
    function qHtml(q){return q.rich?(q.text||''):esc(q.text);}
    function ansText(q,ans){
      if(q.type==='multiple'){const idx=parseInt(ans,10);return isNaN(idx)?'':(['الف','ب','ج','د'][idx]+') '+esc((q.options&&q.options[idx])||''));}
      if(q.type==='truefalse'){return ans==='true'?'صحیح':(ans==='false'?'غلط':'');}
      return esc(ans);
    }

    async function load(){
      const r = await fetch('/api/exam/'+encodeURIComponent(ID));
      const d = await r.json();
      if(!d.ok){document.body.innerHTML='<div class="wrap"><div class="card"><h2>'+d.error+'</h2></div></div>';return;}
      DATA = d;
      document.getElementById('hdr2').innerHTML='<h3 style="margin:0">'+esc(d.meta.school||'')+'</h3>';
      if(d.submitted){ renderResult(d.result); }
      else { document.getElementById('step-info').classList.remove('hidden'); }
    }

    function renderResult(res){
      const done=document.getElementById('step-done');
      done.classList.remove('hidden');
      if(!res.grading || !res.grading.graded){
        done.innerHTML='<h2>پاسخنامه شما ثبت شد ✅</h2><p class="muted">پاسخ‌های شما برای معلم ارسال شد. نتیجه پس از تصحیح معلم همین‌جا نمایش داده می‌شود.</p>';
        return;
      }
      const g=res.grading;
      let rows=res.questions.map((q,i)=>{
        const ans=res.answers[q.id];
        const mark=g.marks[q.id]||'';
        const fb=g.feedback[q.id]||'';
        const mlabel={correct:'صحیح',wrong:'غلط',partial:'نیمه‌درست'}[mark]||'';
        return '<tr><td>'+(i+1)+'</td><td>'+qHtml(q)+(q.image?'<br><img src="'+q.image+'" class="imgprev">':'')+'</td>'+
          '<td>'+(ansText(q,ans)||'<i>بدون پاسخ</i>')+'</td>'+
          '<td><span class="mark '+mark+'">'+mlabel+'</span></td>'+
          '<td>'+esc(fb)+'</td></tr>';
      }).join('');
      done.innerHTML='<h2>نتیجه آزمون</h2>'+
        '<p class="muted">نام: '+esc(res.student.name)+' | نام درس: '+esc(res.student.courseName||'')+' | تاریخ: '+esc(res.student.examDate||'')+'</p>'+
        '<table><tr><th>#</th><th>سوال</th><th>پاسخ شما</th><th>وضعیت</th><th>بازخورد معلم</th></tr>'+rows+'</table>'+
        (g.overall?'<p style="margin-top:12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:10px"><b>بازخورد کلی معلم:</b> '+esc(g.overall)+'</p>':'');
    }

    function renderQuestions(){
      document.getElementById('sec-q'); // noop
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
        const img=q.image?'<img src="'+q.image+'" class="imgprev">':'';
        return '<div class="q-block"><div class="qhead"><b>'+(i+1)+'. '+qHtml(q)+'</b><span class="badge">'+typeLabel(q.type)+'</span></div>'+img+body+'</div>';
      }).join('');
    }

    document.getElementById('btn-enter').onclick=()=>{
      const name=document.getElementById('f-name').value.trim();
      const father=document.getElementById('f-father').value.trim();
      const nid=document.getElementById('f-nid').value.trim();
      const course=document.getElementById('f-course').value.trim();
      const date=document.getElementById('f-date').value.trim();
      const sec=document.getElementById('f-sec').value.trim();
      const err=document.getElementById('info-err');
      if(!name||!father||!nid||!course||!date){err.textContent='لطفاً همه فیلدها را پر کنید.';return;}
      if(parseInt(sec,10)!==a+b){err.textContent='پاسخ سوال امنیتی اشتباه است.';return;}
      err.textContent='';
      window._student={name,fatherName:father,nationalId:nid,courseName:course,examDate:date};
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
        renderResult({grading:null});
      }else{toast(d.error||'خطا در ثبت');btn.disabled=false;btn.textContent='ثبت نهایی پاسخنامه';}
    };

    // مقداردهی اولیه سوال امنیتی و تاریخ
    document.getElementById('sec-q').textContent = a + ' + ' + b + ' = ؟';
    try{ document.getElementById('f-date').value = new Date().toLocaleDateString('fa-IR'); }catch(e){}
    load();
  </script></body></html>`);
}

/* ------------------------- پنل معلم ------------------------- */

function teacherPage() {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(APP_TITLE)}</title>${FONT_LINK}<style>${SHARED_CSS}</style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script></head>
  <body><div class="wrap">
    ${pageHeader()}

    <!-- ورود -->
    <div class="card" id="login">
      <h3 id="login-head">ورود معلم</h3>
      <p class="muted" id="login-hint"></p>
      <label>رمز عبور</label><input id="pass" type="password" autocomplete="current-password">
      <p class="muted" id="login-err" style="color:var(--danger)"></p>
      <button class="btn" id="btn-login">ورود</button>
    </div>

    <!-- داشبورد -->
    <div id="dash" class="hidden">
      <div class="tabs">
        <div class="tab active" data-tab="students">📋 دانش‌آموزان</div>
        <div class="tab" data-tab="questions">✏️ سوالات</div>
        <div class="tab" data-tab="answers">✅ تصحیح</div>
        <div class="tab" data-tab="tables">📊 جدول‌ساز</div>
        <div class="tab" data-tab="scan">📷 اسکنر</div>
        <div class="tab" data-tab="resize">🖼️ کاهش حجم</div>
        <div class="tab" data-tab="pdf2word">📄 PDF به Word</div>
        <div class="tab" data-tab="settings">⚙️ تنظیمات</div>
        <div class="tab" id="btn-logout" style="background:#fee2e2;color:#991b1b">🚪 خروج</div>
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
        <label>نام مدرسه</label><input id="m-school">
        <p class="muted">نام مدرسه را خودتان وارد کنید؛ همین نام در بالای برگه‌ی آزمون (خروجی Word) نمایش داده می‌شود.<br>
        دانش‌آموز هنگام آزمون این موارد را پر می‌کند: نام و نام خانوادگی، نام پدر، کد ملی، نام درس، تاریخ آزمون.</p>
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

      <!-- پاسخنامه‌ها / تصحیح -->
      <div class="card tab-content hidden" id="tab-answers">
        <h3>تصحیح و پاسخنامه‌ها</h3>
        <button class="btn gray sm" id="btn-refresh-ans">به‌روزرسانی</button>
        <div id="answers-list"></div>
      </div>

      <!-- جدول / اکسل -->
      <div class="card tab-content hidden" id="tab-tables">
        <h3>📊 جدول‌ساز و خروجی اکسل</h3>
        <p class="muted">هر جدول را با تعداد سطر و ستون دلخواه بسازید، موضوع بالای هر جدول را بنویسید و خانه‌ها را پر کنید، سپس خروجی اکسل بگیرید.</p>
        <div class="row" style="margin-top:12px; gap:12px; align-items:center; flex-wrap:wrap">
          <button class="btn primary" id="btn-add-table">
            <span style="margin-left:6px">➕</span> افزودن جدول جدید
          </button>
          <button class="btn success" id="btn-dl-excel">
            <span style="margin-left:6px">📥</span> دانلود اکسل (xls)
          </button>
        </div>
        <div id="tables-list" style="margin-top:20px"></div>
      </div>

      <!-- اسکنر عکس -->
      <div class="card tab-content hidden" id="tab-scan">
        <h3>📷 اسکنر حرفه‌ای (مشابه CamScanner)</h3>
        <div id="scan-upload-area" style="border:3px dashed #3b82f6;border-radius:20px;padding:40px 20px;text-align:center;background:linear-gradient(135deg,#eff6ff,#dbeafe);margin:16px 0;cursor:pointer;transition:all 0.3s" onclick="document.getElementById('scan-file').click()">
          <div style="font-size:56px;margin-bottom:12px">📸</div>
          <p style="font-size:16px;color:#1e40af;font-weight:600">برای انتخاب عکس کلیک کنید یا عکس را اینجا رها کنید</p>
          <p style="font-size:13px;color:#64748b;margin-top:6px">فرمت‌های支持: JPG, PNG, WEBP, HEIC</p>
        </div>
        <input type="file" accept="image/*" id="scan-file" style="display:none">
        <div id="scan-controls" class="hidden">
          <!-- حالت‌های اسکن -->
          <div style="background:#f8fafc;border-radius:16px;padding:16px;margin:16px 0">
            <p style="font-weight:600;color:#374151;margin-bottom:12px">🎨 حالت اسکن:</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn sm active" id="scan-mode-color" onclick="setScanMode('color')" style="background:#3b82f6;color:#fff;border:2px solid #3b82f6">🌈 رنگی</button>
              <button class="btn sm" id="scan-mode-gray" onclick="setScanMode('gray')" style="background:#fff;color:#374151;border:2px solid #e2e8f0">⬛ سیاه و سفید</button>
              <button class="btn sm" id="scan-mode-bw" onclick="setScanMode('bw')" style="background:#fff;color:#374151;border:2px solid #e2e8f0">📄 سند سفید</button>
              <button class="btn sm" id="scan-mode-enhance" onclick="setScanMode('enhance')" style="background:#fff;color:#374151;border:2px solid #e2e8f0">✨ بهبود خودکار</button>
            </div>
          </div>
          
          <!-- کنترل‌های ویرایش -->
          <div id="scan-adjustments" style="background:#fff;border:2px solid #e2e8f0;border-radius:16px;padding:16px;margin:16px 0">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
              <p style="font-weight:600;color:#374151">⚙️ تنظیمات دستی</p>
              <button class="btn sm" onclick="resetScanAdjustments()" style="background:#f1f5f9;color:#64748b">🔄 بازنشانی</button>
            </div>
            <div class="row">
              <div><label>🔆 روشنایی</label><input type="range" id="scan-bright" min="-100" max="100" value="0" oninput="applyScan()"></div>
              <div><label>◐ کنتراست</label><input type="range" id="scan-contrast" min="-50" max="50" value="0" oninput="applyScan()"></div>
            </div>
            <div class="row" style="margin-top:12px">
              <div><label>🎨 اشباع رنگ</label><input type="range" id="scan-saturation" min="-100" max="100" value="0" oninput="applyScan()"></div>
              <div><label>🔘 ته رنگ</label><input type="range" id="scan-hue" min="-180" max="180" value="0" oninput="applyScan()"></div>
            </div>
            <div class="row" style="margin-top:12px">
              <div><label>🔥 شدت رنگ</label><input type="range" id="scan-vibrance" min="-100" max="100" value="0" oninput="applyScan()"></div>
              <div><label>☀️ گرمی/سردی</label><input type="range" id="scan-temperature" min="-50" max="50" value="0" oninput="applyScan()"></div>
            </div>
          </div>
          
          <!-- ابزارهای ویرایش -->
          <div style="background:#fff;border:2px solid #e2e8f0;border-radius:16px;padding:16px;margin:16px 0">
            <p style="font-weight:600;color:#374151;margin-bottom:12px">🔧 ابزارهای ویرایش</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn sm" onclick="rotateScan(-90)" title="چرخش 90 درجه چپ">↩️ چرخش چپ</button>
              <button class="btn sm" onclick="rotateScan(90)" title="چرخش 90 درجه راست">↪️ چرخش راست</button>
              <button class="btn sm" onclick="flipScan('h')" title="آینه افقی">↔️ آینه افقی</button>
              <button class="btn sm" onclick="flipScan('v')" title="آینه عمودی">↕️ آینه عمودی</button>
              <button class="btn sm" onclick="cropScan()" style="background:#fef3c7;border-color:#f59e0b;color:#92400e">✂️ برش</button>
            </div>
          </div>
          
          <!-- پیش‌نمایش -->
          <div style="overflow:auto;border:2px solid #e2e8f0;border-radius:16px;margin:16px 0;padding:12px;background:#f8fafc;text-align:center">
            <canvas id="scan-canvas" style="max-width:100%;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.1)"></canvas>
          </div>
          
          <!-- دانلود -->
          <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:16px;padding:16px;background:#eff6ff;border-radius:16px">
            <button class="btn primary" id="btn-dl-img" style="flex:1;min-width:150px">
              <span>📥</span> دانلود PNG
            </button>
            <button class="btn success" id="btn-dl-jpg" style="flex:1;min-width:150px">
              <span>📷</span> دانلود JPG
            </button>
            <button class="btn sec" id="btn-dl-pdf" style="flex:1;min-width:150px">
              <span>📄</span> دانلود PDF
            </button>
          </div>
        </div>
      </div>

      <!-- کاهش حجم عکس -->
      <div class="card tab-content hidden" id="tab-resize">
        <h3>📐 کاهش حجم و تغییر اندازه عکس</h3>
        <div id="resize-upload-area" style="border:3px dashed #10b981;border-radius:20px;padding:40px 20px;text-align:center;background:linear-gradient(135deg,#ecfdf5,#d1fae5);margin:16px 0;cursor:pointer" onclick="document.getElementById('resize-file').click()">
          <div style="font-size:56px;margin-bottom:12px">🖼️</div>
          <p style="font-size:16px;color:#047857;font-weight:600">برای انتخاب عکس کلیک کنید</p>
          <p style="font-size:13px;color:#6b7280;margin-top:6px">عکس را با کیفیت و اندازه دلخواه کاهش دهید</p>
        </div>
        <input type="file" accept="image/*" id="resize-file" style="display:none">
        
        <div id="resize-controls" class="hidden" style="background:#fff;border:2px solid #e2e8f0;border-radius:16px;padding:20px;margin:16px 0">
          <div style="display:flex;gap:12px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #e2e8f0">
            <div style="flex:1"><p style="font-size:13px;color:#64748b;margin-bottom:6px">سایز اصلی</p><p id="resize-orig-size" style="font-weight:600;color:#374151">-</p></div>
            <div style="flex:1"><p style="font-size:13px;color:#64748b;margin-bottom:6px">ابعاد اصلی</p><p id="resize-orig-dims" style="font-weight:600;color:#374151">-</p></div>
          </div>
          
          <div style="margin-bottom:20px">
            <label style="display:block;font-weight:600;color:#374151;margin-bottom:12px">📊 کیفیت خروجی: <span id="quality-label">80%</span></label>
            <input type="range" id="resize-quality" min="10" max="100" value="80" style="width:100%" oninput="document.getElementById('quality-label').textContent=this.value+'%';applyResize()">
            <div style="display:flex;justify-content:space-between;font-size:12px;color:#9ca3af;margin-top:4px">
              <span>کیفیت کمتر (حجم کمتر)</span><span>کیفیت بالا (حجم بیشتر)</span>
            </div>
          </div>
          
          <div style="margin-bottom:20px">
            <label style="display:block;font-weight:600;color:#374151;margin-bottom:12px">📏 تغییر اندازه</label>
            <div class="row" style="gap:12px">
              <div style="flex:1">
                <label style="font-size:13px;color:#64748b">عرض (px)</label>
                <input type="number" id="resize-width" min="100" max="4000" value="1920" style="width:100%;margin-top:4px" oninput="applyResize()">
              </div>
              <div style="flex:1">
                <label style="font-size:13px;color:#64748b">ارتفاع (px)</label>
                <input type="number" id="resize-height" min="100" max="4000" value="1080" style="width:100%;margin-top:4px" oninput="applyResize()">
              </div>
            </div>
            <label style="font-weight:400;margin-top:8px;display:flex;align-items:center;gap:8px">
              <input type="checkbox" id="resize-ratio" checked style="width:auto"> حفظ نسبت ابعاد
            </label>
          </div>
          
          <div id="resize-preview" style="text-align:center;margin:20px 0;padding:16px;background:#f8fafc;border-radius:12px">
            <canvas id="resize-canvas" style="max-width:100%;border-radius:8px"></canvas>
            <div style="display:flex;justify-content:center;gap:20px;margin-top:12px">
              <span style="background:#dbeafe;color:#1e40af;padding:4px 12px;border-radius:20px;font-size:13px">📐 <span id="resize-new-dims">-</span></span>
              <span style="background:#dcfce7;color:#166534;padding:4px 12px;border-radius:20px;font-size:13px">💾 <span id="resize-new-size">-</span></span>
            </div>
          </div>
          
          <button class="btn success" id="btn-download-resized" style="width:100%;padding:14px;font-size:16px">
            📥 دانلود عکس با اندازه جدید
          </button>
        </div>
      </div>

      <!-- تبدیل PDF به Word -->
      <div class="card tab-content hidden" id="tab-pdf2word">
        <h3>📄 تبدیل PDF به Word</h3>
        <div style="background:linear-gradient(135deg,#fef3c7,#fde68a);border-radius:16px;padding:16px;margin:16px 0;border:1px solid #fbbf24">
          <div style="display:flex;align-items:flex-start;gap:12px">
            <span style="font-size:28px">⚠️</span>
            <div>
              <p style="font-weight:600;color:#92400e">توجه مهم</p>
              <p style="font-size:13px;color:#a16207;margin-top:4px">این ابزار صفحات PDF را به صورت عکس به Word تبدیل می‌کند. متن‌ها قابل ویرایش نخواهند بود. برای نتیجه بهتر، PDF باید کیفیت بالا و صفحات واضح داشته باشد.</p>
            </div>
          </div>
        </div>
        
        <div id="pdf-upload-area" style="border:3px dashed #f59e0b;border-radius:20px;padding:40px 20px;text-align:center;background:linear-gradient(135deg,#fffbeb,#fef3c7);margin:16px 0;cursor:pointer" onclick="document.getElementById('pdf-file').click()">
          <div style="font-size:56px;margin-bottom:12px">📑</div>
          <p style="font-size:16px;color:#b45309;font-weight:600">فایل PDF را انتخاب کنید</p>
          <p style="font-size:13px;color:#6b7280;margin-top:6px">PDF شما به Word تبدیل خواهد شد</p>
        </div>
        <input type="file" accept=".pdf" id="pdf-file" style="display:none">
        
        <div id="pdf-controls" class="hidden" style="background:#fff;border:2px solid #e2e8f0;border-radius:16px;padding:20px;margin:16px 0">
          <div style="display:flex;align-items:center;gap:12px;padding:16px;background:#f8fafc;border-radius:12px;margin-bottom:16px">
            <span style="font-size:32px">📄</span>
            <div style="flex:1">
              <p id="pdf-name" style="font-weight:600;color:#374151">-</p>
              <p id="pdf-info" style="font-size:13px;color:#64748b;margin-top:2px">-</p>
            </div>
            <button class="btn sm danger" onclick="clearPdf()">🗑️ حذف</button>
          </div>
          
          <div style="margin-bottom:16px">
            <label style="display:block;font-weight:600;color:#374151;margin-bottom:8px">📊 کیفیت پیش‌نمایش</label>
            <select id="pdf-quality" style="width:100%;padding:10px;border:2px solid #e2e8f0;border-radius:10px">
              <option value="72">پایین (سریع)</option>
              <option value="150" selected>متوسط</option>
              <option value="300">بالا (کندتر)</option>
            </select>
          </div>
          
          <div id="pdf-pages" style="display:flex;gap:12px;flex-wrap:wrap;margin:16px 0"></div>
          
          <button class="btn primary" id="btn-convert-pdf" style="width:100%;padding:14px;font-size:16px">
            🔄 تبدیل به Word
          </button>
        </div>
      </div>

      <!-- تنظیمات -->
      <div class="card tab-content hidden" id="tab-settings">
        <h3>تغییر رمز عبور</h3>
        <label>رمز عبور جدید</label><input id="new-pass" type="password" autocomplete="new-password">
        <p class="muted" id="pass-msg"></p>
        <button class="btn" id="btn-change-pass">ذخیره رمز جدید</button>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <script>${teacherScript()}</script>
  </body></html>`;
}

function teacherScript() {
  return `
  const TYPES={descriptive:'تشریحی',multiple:'چهارگزینه‌ای',truefalse:'صحیح/غلط',short:'کوتاه‌پاسخ'};
  const MATH=['+','\u2212','\u00d7','\u00f7','=','\u2260','\u00b1','<','>','\u2264','\u2265','\u221a','\u221b','%','\u03c0','\u00b0','\u00bd','\u00bc','\u00be','\u2153','\u2154','\u215b','\u00b2','\u00b3','( )','[ ]','\u2211','\u220f','\u221e','\u2220','\u22a5','\u2225','\u2234','\u2235','\u2248','\u221d','\u222b','\u2192','\u2190'];
  const SHAPES=['\u25b3','\u25bd','\u25c1','\u25b7','\u25c0','\u25b6','\u25b2','\u25bc','\u25a1','\u25ad','\u25ac','\u25b1','\u25b0','\u25c7','\u25c6','\u2b20','\u2b1f','\u2b21','\u2b22','\u25cb','\u25ef','\u25cf','\u2b24','\u2b2d','\u2605','\u2606','\u23e2','\u22bf','\u25e2','\u25e3','\u25e4','\u25e5','\u2194','\u2191','\u2193','\u2220','\u22a5','\u2225','\u2312','\u2299','\u2014'];
  const SVG_SHAPES=[
    {name:'مکعب', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><rect x="20" y="35" width="45" height="45"/><path d="M20 35 L40 15 L85 15 L65 35"/><path d="M65 35 L65 80 L85 60 L85 15"/></svg>'},
    {name:'استوانه', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><ellipse cx="50" cy="22" rx="30" ry="12"/><path d="M20 22 L20 78"/><path d="M80 22 L80 78"/><path d="M20 78 A30 12 0 0 0 80 78"/></svg>'},
    {name:'مخروط', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M50 12 L20 78"/><path d="M50 12 L80 78"/><ellipse cx="50" cy="78" rx="30" ry="11"/></svg>'},
    {name:'کره', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><circle cx="50" cy="50" r="36"/><ellipse cx="50" cy="50" rx="36" ry="13"/></svg>'},
    {name:'هرم', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M50 12 L18 75 L70 86 Z"/><path d="M50 12 L70 86 L86 64 Z"/><path d="M18 75 L70 86"/></svg>'},
    {name:'مستطیل‌مکعب', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><rect x="14" y="40" width="60" height="38"/><path d="M14 40 L30 22 L90 22 L74 40"/><path d="M74 40 L74 78 L90 60 L90 22"/></svg>'},
    {name:'زاویه', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 80 L85 80"/><path d="M20 80 L78 30"/><path d="M44 80 A24 24 0 0 0 38 64"/></svg>'},
    {name:'پاره‌خط', svg:'<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3"><path d="M14 50 L86 50"/><circle cx="14" cy="50" r="4" fill="currentColor"/><circle cx="86" cy="50" r="4" fill="currentColor"/></svg>'}
  ];
  let QUESTIONS=[], META={}, SUBS=[];
  function esc(s){const d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
  function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2500);}
  function uid(){return 'q-'+Math.random().toString(36).slice(2,10);}
  async function api(path,opts){const r=await fetch(path,opts);return r.json();}

  // ---- ورود ----
  async function checkAuth(){
    const d=await api('/api/teacher/state');
    if(d.auth){showDash();return;}
    if(!d.configured){
      document.getElementById('login-head').textContent='تعریف رمز عبور (اولین ورود)';
      document.getElementById('login-hint').textContent='این اولین ورود است؛ یک رمز دلخواه (حداقل ۴ کاراکتر) وارد کنید تا به‌عنوان رمز معلم ثبت شود.';
      document.getElementById('btn-login').textContent='ثبت رمز و ورود';
    }
  }
  document.getElementById('btn-login').onclick=async()=>{
    const p=document.getElementById('pass').value;
    const d=await api('/api/teacher/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:p})});
    if(d.ok){if(d.created)toast('رمز عبور شما ثبت شد');showDash();}else document.getElementById('login-err').textContent=d.error||'خطا';
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
    if(t.dataset.tab==='tables')renderTables();
  });

  // ---- دانش‌آموزان ----
  async function loadStudents(){
    const d=await api('/api/teacher/students');
    const box=document.getElementById('students-list');
    if(!d.students.length){box.innerHTML='<p class="muted">هنوز دانش‌آموزی ساخته نشده است.</p>';return;}
    box.innerHTML='<table><tr><th>#</th><th>نام</th><th>لینک اختصاصی</th><th>وضعیت</th><th></th></tr>'+
      d.students.map((s,i)=>{
        const link=location.origin+'/s/'+s.uuid;
        let st='<span class="pill no">در انتظار</span>';
        if(s.status==='submitted')st='<span class="pill gr">ثبت‌شده (تصحیح‌نشده)</span>';
        if(s.status==='graded')st='<span class="pill ok">تصحیح‌شده</span>';
        return '<tr><td>'+(i+1)+'</td><td>'+esc(s.label||'-')+'</td>'+
          '<td><div class="link-box">'+link+'</div></td>'+
          '<td>'+st+'</td>'+
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
    document.getElementById('m-school').value=META.school||'';
    renderQ();
  }
  function renderQ(){
    const box=document.getElementById('q-list');
    box.innerHTML=QUESTIONS.map((q,i)=>qBlock(q,i)).join('')||'<p class="muted">سوالی اضافه نشده است.</p>';
  }
  function escA(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
  function qHtml(q){return q.rich?(q.text||''):esc(q.text);}
  function symBar(i){
    const mk=(arr,fn)=>arr.map(s=>'<button type="button" onmousedown="event.preventDefault()" onclick="'+fn+'('+i+',\\''+escA(s)+'\\')">'+escA(s)+'</button>').join('');
    let h='<div class="toolbar"><span class="grp-label">علائم ریاضی:</span>'+mk(MATH,'insSym')+
      '<button type="button" onmousedown="event.preventDefault()" onclick="insFrac('+i+')">کسر a/b</button>'+
      '<button type="button" onmousedown="event.preventDefault()" onclick="insDiv('+i+')">تقسیم چكشی</button></div>';
    h+='<div class="toolbar"><span class="grp-label">اشکال هندسی:</span>'+
      '<span class="grp-label">اندازه:</span><input type="range" min="14" max="140" value="40" id="ssz-'+i+'" style="width:110px;vertical-align:middle" oninput="resizeSel('+i+')"> '+
      mk(SHAPES,'insShape')+
      SVG_SHAPES.map((s,si)=>'<button type="button" title="'+escA(s.name)+'" onmousedown="event.preventDefault()" onclick="insSvg('+i+','+si+')">'+escA(s.name)+'</button>').join('')+'</div>'+
      '<p class="muted" style="margin:2px 0 0">برای تغییر اندازه‌ی یک شکل، ابتدا روی آن کلیک کنید سپس نوار «اندازه» را بکشید.</p>';
    return h;
  }
  function qBlock(q,i){
    let body;
    if(q.type==='descriptive'){
      body='<label>متن سوال</label>'+symBar(i)+
        '<div class="rich" data-qd="'+i+'" contenteditable="true" oninput="updHtml('+i+')">'+qHtml(q)+'</div>';
      body+='<label>عکس / شکل (اختیاری)</label>';
      if(q.image){body+='<img src="'+q.image+'" class="imgprev"><div><button class="btn sm danger" type="button" onclick="rmImg('+i+')">حذف عکس</button></div>';}
      else{body+='<input type="file" accept="image/*" onchange="loadImg('+i+',this)">';}
    }else{
      body='<label>متن سوال</label><textarea data-qd="'+i+'" oninput="upd('+i+',\\'text\\',this.value)">'+esc(q.text)+'</textarea>';
      if(q.type==='multiple'){
        body+='<label>گزینه صحیح</label><select onchange="upd('+i+',\\'correct\\',this.value)">'+
          [0,1,2,3].map(n=>'<option value="'+n+'" '+(String(q.correct)===String(n)?'selected':'')+'>'+['الف','ب','ج','د'][n]+'</option>').join('')+'</select>';
        body+='<label>گزینه‌ها</label>';
        for(let oi=0;oi<4;oi++){
          body+='<div class="opt-row"><span>'+['الف','ب','ج','د'][oi]+')</span><input type="text" value="'+esc((q.options&&q.options[oi])||'')+'" oninput="updOpt('+i+','+oi+',this.value)"></div>';
        }
      }else if(q.type==='truefalse'){
        body+='<label>پاسخ صحیح</label><select onchange="upd('+i+',\\'correct\\',this.value)">'+
          '<option value="true" '+(String(q.correct)==='true'?'selected':'')+'>صحیح</option>'+
          '<option value="false" '+(String(q.correct)==='false'?'selected':'')+'>غلط</option></select>';
      }else if(q.type==='short'){
        body+='<label>پاسخ نمونه (اختیاری)</label><input type="text" value="'+esc(q.correct||'')+'" oninput="upd('+i+',\\'correct\\',this.value)">';
      }
    }
    return '<div class="q-block"><div class="qhead"><b>سوال '+(i+1)+'</b>'+
      '<span><span class="badge">'+TYPES[q.type]+'</span> '+
      '<button class="btn sm gray" onclick="moveQ('+i+',-1)">▲</button> '+
      '<button class="btn sm gray" onclick="moveQ('+i+',1)">▼</button> '+
      '<button class="btn sm danger" onclick="delQ('+i+')">حذف</button></span></div>'+body+'</div>';
  }
  window.upd=(i,k,v)=>{QUESTIONS[i][k]=v;};
  window.updOpt=(i,oi,v)=>{QUESTIONS[i].options=QUESTIONS[i].options||['','','',''];QUESTIONS[i].options[oi]=v;};
  window.delQ=(i)=>{QUESTIONS.splice(i,1);renderQ();};
  window.moveQ=(i,dir)=>{const j=i+dir;if(j<0||j>=QUESTIONS.length)return;const t=QUESTIONS[i];QUESTIONS[i]=QUESTIONS[j];QUESTIONS[j]=t;renderQ();};

  // ---- ویرایشگر متنی سوال تشریحی (علائم ریاضی، کسر، تقسیم، اشکال هندسی) ----
  function richEl(i){return document.querySelector('.rich[data-qd="'+i+'"]');}
  function ssize(i){const r=document.getElementById('ssz-'+i);return r?parseInt(r.value,10):40;}
  function insHtmlAt(i,h){
    const el=richEl(i);if(!el)return;
    el.focus();
    const sel=document.getSelection();
    if(!sel.rangeCount||!el.contains(sel.anchorNode)){const r=document.createRange();r.selectNodeContents(el);r.collapse(false);sel.removeAllRanges();sel.addRange(r);}
    document.execCommand('insertHTML',false,h);
    updHtml(i);
  }
  window.insSym=(i,s)=>insHtmlAt(i,escA(s));
  window.insShape=(i,s)=>insHtmlAt(i,'<span class="shape" contenteditable="false" style="font-size:'+ssize(i)+'px">'+escA(s)+'</span>&#8203;');
  window.insSvg=(i,si)=>{const s=SVG_SHAPES[si];if(!s)return;const z=ssize(i);const svg=s.svg.replace('<svg','<svg width="'+z+'" height="'+z+'"');insHtmlAt(i,'<span class="shape" contenteditable="false">'+svg+'</span>&#8203;');};
  window.insFrac=(i)=>{const n=prompt('صورت کسر:');if(n===null)return;const d=prompt('مخرج کسر:');if(d===null)return;insHtmlAt(i,'<span class="frac" contenteditable="false"><span class="fn">'+escA(n)+'</span><span class="fd">'+escA(d)+'</span></span>&#8203;');};
  window.insDiv=(i)=>{const dd=prompt('مقسوم:','')||'مقسوم';const dv=prompt('مقسوم‌علیه:','')||'مقسوم‌علیه';insHtmlAt(i,'<table class="ldiv"><tr><td class="dividend">'+escA(dd)+'</td><td class="divisor">'+escA(dv)+'</td></tr><tr><td class="work"><br></td><td class="quotient">خارج‌قسمت</td></tr></table>&#8203;');};
  window.updHtml=(i)=>{const el=richEl(i);if(!el)return;const c=el.cloneNode(true);c.querySelectorAll('.shape').forEach(s=>{s.style.outline='';});QUESTIONS[i].text=c.innerHTML;QUESTIONS[i].rich=true;};
  let SELSHAPE=null;
  document.addEventListener('click',function(e){
    const sh=e.target&&e.target.closest?e.target.closest('.shape'):null;
    if(sh&&sh.closest('.rich')){
      if(SELSHAPE)SELSHAPE.style.outline='';
      SELSHAPE=sh;sh.style.outline='2px solid #2563eb';
      const i=sh.closest('.rich').getAttribute('data-qd');const r=document.getElementById('ssz-'+i);
      if(r){const svg=sh.querySelector('svg');const cur=svg?parseInt(svg.getAttribute('width'),10):parseInt((sh.style.fontSize||'40'),10);if(cur)r.value=cur;}
    }else if(SELSHAPE){SELSHAPE.style.outline='';SELSHAPE=null;}
  });
  window.resizeSel=(i)=>{
    const r=document.getElementById('ssz-'+i);if(!r)return;
    if(SELSHAPE&&SELSHAPE.closest('.rich')&&SELSHAPE.closest('.rich').getAttribute('data-qd')==String(i)){
      const z=parseInt(r.value,10);const svg=SELSHAPE.querySelector('svg');
      if(svg){svg.setAttribute('width',z);svg.setAttribute('height',z);}else{SELSHAPE.style.fontSize=z+'px';}
      updHtml(i);
    }
  };
  window.loadImg=(i,input)=>{
    const f=input.files[0];if(!f)return;
    const rd=new FileReader();
    rd.onload=ev=>{
      const img=new Image();
      img.onload=()=>{
        const c=document.createElement('canvas');const mw=800;let w=img.width,h=img.height;
        if(w>mw){h=Math.round(h*mw/w);w=mw;}
        c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0,w,h);
        QUESTIONS[i].image=c.toDataURL('image/jpeg',0.85);renderQ();
      };img.src=ev.target.result;
    };rd.readAsDataURL(f);
  };
  window.rmImg=(i)=>{QUESTIONS[i].image='';renderQ();};
  document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{
    const t=b.dataset.add;
    QUESTIONS.push({id:uid(),type:t,rich:t==='descriptive',text:'',options:t==='multiple'?['','','','']:[],correct:t==='multiple'?'0':(t==='truefalse'?'true':''),image:''});
    renderQ();
  });
  document.getElementById('btn-save-q').onclick=async()=>{
    META={school:document.getElementById('m-school').value};
    const d=await api('/api/teacher/questions',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({questions:QUESTIONS,meta:META})});
    if(d.ok)toast('ذخیره شد');else toast(d.error||'خطا');
  };

  // ---- تصحیح و پاسخنامه‌ها ----
  function ansText(q,ans){
    if(q.type==='multiple'){const idx=parseInt(ans,10);return isNaN(idx)?'':(['الف','ب','ج','د'][idx]+') '+esc((q.options&&q.options[idx])||''));}
    if(q.type==='truefalse'){return ans==='true'?'صحیح':(ans==='false'?'غلط':'');}
    return esc(ans);
  }
  async function loadAnswers(){
    const d=await api('/api/teacher/submissions');
    SUBS=d.submissions||[];
    const box=document.getElementById('answers-list');
    if(!SUBS.length){box.innerHTML='<p class="muted">هنوز پاسخنامه‌ای ثبت نشده است.</p>';return;}
    box.innerHTML=SUBS.map((s,si)=>{
      const g=s.grading||{graded:false,feedback:{},marks:{},overall:''};
      const rows=(s.questionsSnapshot||[]).map((q,i)=>{
        const ans=s.answers?s.answers[q.id]:'';
        const fb=(g.feedback&&g.feedback[q.id])||'';
        const mk=(g.marks&&g.marks[q.id])||'';
        const opt=(v,t)=>'<option value="'+v+'" '+(mk===v?'selected':'')+'>'+t+'</option>';
        return '<tr><td>'+(i+1)+'</td><td>'+qHtml(q)+(q.image?'<br><img src="'+q.image+'" class="imgprev">':'')+'</td>'+
          '<td>'+(ansText(q,ans)||'<i>بدون پاسخ</i>')+'</td>'+
          '<td><select id="mk_'+s.uuid+'_'+q.id+'"><option value="">—</option>'+opt('correct','صحیح')+opt('wrong','غلط')+opt('partial','نیمه‌درست')+'</select></td>'+
          '<td><input type="text" id="fb_'+s.uuid+'_'+q.id+'" value="'+esc(fb)+'" placeholder="بازخورد"></td></tr>';
      }).join('');
      const badge=g.graded?'<span class="pill ok">تصحیح‌شده</span>':'<span class="pill gr">در انتظار تصحیح</span>';
      return '<div class="q-block"><div class="qhead"><b>'+esc(s.student.name)+'</b> '+badge+
        ' <a class="btn sm sec" href="/api/teacher/word?type=answers&uuid='+s.uuid+'">دانلود Word</a></div>'+
        '<p class="muted">نام پدر: '+esc(s.student.fatherName)+' | کد ملی: '+esc(s.student.nationalId)+' | نام درس: '+esc(s.student.courseName||'')+' | تاریخ آزمون: '+esc(s.student.examDate||'')+' | ثبت: '+new Date(s.submittedAt).toLocaleString('fa-IR')+'</p>'+
        '<table><tr><th>#</th><th>سوال</th><th>پاسخ دانش‌آموز</th><th>وضعیت</th><th>بازخورد</th></tr>'+rows+'</table>'+
        '<label>بازخورد کلی</label><textarea id="ov_'+s.uuid+'">'+esc(g.overall||'')+'</textarea>'+
        '<button class="btn" style="margin-top:8px" onclick="saveGrade(\\''+s.uuid+'\\')">ثبت تصحیح</button></div>';
    }).join('');
  }
  window.saveGrade=async(uuid)=>{
    const sub=SUBS.find(x=>x.uuid===uuid);if(!sub)return;
    const feedback={},marks={};
    (sub.questionsSnapshot||[]).forEach(q=>{
      const fb=document.getElementById('fb_'+uuid+'_'+q.id);const mk=document.getElementById('mk_'+uuid+'_'+q.id);
      if(fb)feedback[q.id]=fb.value;
      if(mk&&mk.value)marks[q.id]=mk.value;
    });
    const overall=document.getElementById('ov_'+uuid).value;
    const d=await api('/api/teacher/grade',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uuid,feedback,marks,overall})});
    if(d.ok){toast('تصحیح ثبت شد');loadAnswers();}else toast(d.error||'خطا');
  };
  document.getElementById('btn-refresh-ans').onclick=loadAnswers;

  // ---- تغییر رمز عبور ----
  document.getElementById('btn-change-pass').onclick=async()=>{
    const np=document.getElementById('new-pass').value;
    const msg=document.getElementById('pass-msg');
    const d=await api('/api/teacher/password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({newPassword:np})});
    if(d.ok){msg.style.color='#166534';msg.textContent='رمز عبور با موفقیت تغییر کرد.';document.getElementById('new-pass').value='';}
    else{msg.style.color='var(--danger)';msg.textContent=d.error||'خطا';}
  };

  // ---- جدول‌ساز / خروجی اکسل ----
  let TABLES=[];
  function blankRows(rows,cols,old){
    const data=[];
    for(let r=0;r<rows;r++){const row=[];for(let c=0;c<cols;c++){row.push((old&&old[r]&&old[r][c]!=null)?old[r][c]:'');}data.push(row);}
    return data;
  }
  window.renderTables=function(){
    const box=document.getElementById('tables-list');
    if(!TABLES.length){
      box.innerHTML='<div style="text-align:center;padding:40px 20px;background:linear-gradient(135deg,#f8fafc,#f1f5f9);border-radius:16px;border:2px dashed #cbd5e1">'+
        '<div style="font-size:48px;margin-bottom:12px">📋</div>'+
        '<p style="color:#64748b;font-size:15px">هنوز جدولی ساخته نشده است</p>'+
        '<p style="color:#94a3b8;font-size:13px;margin-top:6px">روی دکمه «افزودن جدول جدید» بزنید</p></div>';
      return;
    }
    box.innerHTML=TABLES.map((t,ti)=>{
      let h='<div class="q-block" style="border:2px solid #e2e8f0;border-radius:16px;overflow:hidden;margin-bottom:20px;box-shadow:0 4px 12px rgba(0,0,0,0.05)">'+
        '<div class="qhead" style="background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">'+
        '<div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">📊</span><b>جدول '+(ti+1)+'</b></div>'+
        '<button class="btn sm danger" onclick="delTable('+ti+')" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);color:#fff">🗑️ حذف</button></div>';
      h+='<div style="padding:16px 20px;background:#fff">';
      h+='<div style="margin-bottom:16px"><label style="display:block;font-weight:600;color:#374151;margin-bottom:8px">📝 موضوع جدول</label><input value="'+esc(t.title)+'" oninput="updTableTitle('+ti+',this.value)" style="width:100%;padding:10px 14px;border:2px solid #e2e8f0;border-radius:10px;font-size:14px;transition:border-color 0.2s" onfocus="this.style.borderColor=\'#3b82f6\'" onblur="this.style.borderColor=\'#e2e8f0\'"></div>';
      h+='<div class="row" style="margin-bottom:16px;gap:16px">';
      h+='<div style="flex:1;min-width:140px"><label style="display:block;font-weight:600;color:#374151;margin-bottom:8px">↕️ تعداد سطر</label><input type="number" min="1" max="60" value="'+t.rows+'" onchange="resizeTable('+ti+',\\'rows\\',this.value)" style="width:100%;padding:10px 14px;border:2px solid #e2e8f0;border-radius:10px"></div>';
      h+='<div style="flex:1;min-width:140px"><label style="display:block;font-weight:600;color:#374151;margin-bottom:8px">↔️ تعداد ستون</label><input type="number" min="1" max="20" value="'+t.cols+'" onchange="resizeTable('+ti+',\\'cols\\',this.value)" style="width:100%;padding:10px 14px;border:2px solid #e2e8f0;border-radius:10px"></div>';
      h+='</div>';
      h+='<div style="overflow:auto;border-radius:12px;border:1px solid #e2e8f0"><table style="width:100%;border-collapse:collapse;min-width:300px">';
      for(let r=0;r<t.rows;r++){
        h+='<tr>';
        for(let c=0;c<t.cols;c++){
          const isFirstCol=(c===0);
          h+='<td contenteditable="true" oninput="updCell('+ti+','+r+','+c+',this.innerText)" style="border:1px solid #e2e8f0;padding:12px 14px;min-width:80px;background:'+(r%2===0?'#fff':'#f8fafc')+';text-align:right;direction:rtl;font-size:14px">'+esc(t.data[r][c]||'')+'</td>';
        }
        h+='</tr>';
      }
      h+='</table></div></div></div>';
      return h;
    }).join('');
  };
  window.updTableTitle=(ti,v)=>{TABLES[ti].title=v;};
  window.updCell=(ti,r,c,v)=>{TABLES[ti].data[r][c]=v;};
  window.delTable=(ti)=>{if(!confirm('این جدول حذف شود؟'))return;TABLES.splice(ti,1);renderTables();};
  window.resizeTable=(ti,k,v)=>{const n=Math.max(1,parseInt(v,10)||1);const t=TABLES[ti];if(k==='rows')t.rows=n;else t.cols=n;t.data=blankRows(t.rows,t.cols,t.data);renderTables();};
  document.getElementById('btn-add-table').onclick=()=>{TABLES.push({title:'',rows:3,cols:3,data:blankRows(3,3)});renderTables();};
  document.getElementById('btn-dl-excel').onclick=()=>{
    if(!TABLES.length){toast('ابتدا یک جدول بسازید');return;}
    let html='<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><style>body{direction:rtl;font-family:Tahoma,Arial,sans-serif}.title{font-size:16px;font-weight:bold;color:#1e40af;margin:20px 0 10px;padding:10px;background:linear-gradient(135deg,#dbeafe,#bfdbfe);border-radius:8px}table{border-collapse:collapse;width:100%;margin-bottom:20px}th{background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;padding:12px 16px;text-align:right;border:1px solid #1e40af}td{border:1px solid #2563eb;padding:10px 14px;text-align:right;background:#fff}tr:nth-child(even) td{background:#f0f9ff}</style></head><body>';
    TABLES.forEach(t=>{if(t.title)html+='<div class="title">'+esc(t.title)+'</div>';html+='<table>';t.data.forEach((row,ri)=>{html+='<tr>';row.forEach(c=>{html+='<td>'+esc(c)+'</td>';});html+='</tr>';});html+='</table>';});
    html+='</body></html>';
    const blob=new Blob(['\\ufeff'+html],{type:'application/vnd.ms-excel'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='جداول.xls';document.body.appendChild(a);a.click();a.remove();
    toast('فایل اکسل ساخته شد ✅');
  };

  // ---- اسکنر عکس ----
  let SCANIMG=null, SCANMODE='color', SCANROTATE=0, SCANFLIP={h:false,v:false};
  
  window.setScanMode=function(mode){
    SCANMODE=mode;
    ['color','gray','bw','enhance'].forEach(m=>{
      const btn=document.getElementById('scan-mode-'+m);
      if(btn){btn.style.background=m===mode?'#3b82f6':'#fff';btn.style.color=m===mode?'#fff':'#374151';btn.style.borderColor=m===mode?'#3b82f6':'#e2e8f0';}
    });
    applyScan();
  };
  
  window.resetScanAdjustments=function(){
    document.getElementById('scan-bright').value=0;
    document.getElementById('scan-contrast').value=0;
    document.getElementById('scan-saturation').value=0;
    document.getElementById('scan-hue').value=0;
    document.getElementById('scan-vibrance').value=0;
    document.getElementById('scan-temperature').value=0;
    applyScan();
  };
  
  document.getElementById('scan-file').addEventListener('change',function(){
    const f=this.files[0];if(!f)return;
    document.getElementById('scan-upload-area').classList.add('hidden');
    const rd=new FileReader();
    rd.onload=ev=>{const img=new Image();img.onload=()=>{SCANIMG=img;SCANROTATE=0;SCANFLIP={h:false,v:false};document.getElementById('scan-controls').classList.remove('hidden');applyScan();};img.src=ev.target.result;};
    rd.readAsDataURL(f);
  });
  
  function applyScan(){
    if(!SCANIMG)return;
    const cv=document.getElementById('scan-canvas');const ctx=cv.getContext('2d');
    const mw=1400;let w=SCANIMG.width,h=SCANIMG.height;
    
    // اعمال چرخش
    const rad=(SCANROTATE*Math.PI)/180;
    const cos=Math.abs(Math.cos(rad)),sin=Math.abs(Math.sin(rad));
    if(SCANROTATE%180!==0){cv.width=h*cos+w*sin;cv.height=w*cos+h*sin;}else{cv.width=w;cv.height=h;}
    ctx.clearRect(0,0,cv.width,cv.height);
    ctx.save();
    if(SCANROTATE%180!==0){ctx.translate(cv.width/2,cv.height/2);ctx.rotate(rad);ctx.drawImage(SCANIMG,-SCANIMG.width/2,-SCANIMG.height/2);}
    else{ctx.drawImage(SCANIMG,0,0,w,h);}
    ctx.restore();
    
    // اعمال flip
    if(SCANFLIP.h||SCANFLIP.v){ctx.save();ctx.scale(SCANFLIP.h?-1:1,SCANFLIP.v?-1:1);if(SCANFLIP.h)ctx.drawImage(cv,-cv.width,0);if(SCANFLIP.v)ctx.drawImage(cv,0,-cv.height);ctx.restore();}
    
    w=cv.width;h=cv.height;
    let im=ctx.getImageData(0,0,w,h);let d=im.data;
    const bright=parseFloat(document.getElementById('scan-bright').value)/100;
    const contrast=parseFloat(document.getElementById('scan-contrast').value)/100;
    const sat=parseFloat(document.getElementById('scan-saturation').value)/100;
    const hue=parseFloat(document.getElementById('scan-hue').value)/100;
    const vibrance=parseFloat(document.getElementById('scan-vibrance').value)/100;
    const temp=parseFloat(document.getElementById('scan-temperature').value)/100;
    
    for(let i=0;i<d.length;i+=4){
      let r=d[i],g=d[i+1],b=d[i+2];
      
      // حالت‌های اسکن
      if(SCANMODE==='bw'){const y=0.299*r+0.587*g+0.114*b;r=g=b=y>140?255:0;}
      else if(SCANMODE==='gray'){const y=0.299*r+0.587*g+0.114*b;r=g=b=y;}
      else if(SCANMODE==='enhance'){
        const y=0.299*r+0.587*g+0.114*b;const cFac=1.3,sFac=1.4;
        r=y+(r-y)*cFac;g=y+(g-y)*cFac;b=y+(b-y)*cFac;r=g=b=Math.min(255,Math.max(0,y+(r-g)*sFac));
      }
      
      // تنظیمات دستی
      r=r*(1+contrast);g=g*(1+contrast);b=b*(1+contrast);
      r+=bright*255;g+=bright*255;b+=bright*255;
      
      // اشباع رنگ
      if(sat!==0){
        const gray=0.299*r+0.587*g+0.114*b;
        r=gray+(r-gray)*(1+sat);g=gray+(g-gray)*(1+sat);b=gray+(b-gray)*(1+sat);
      }
      
      // ته رنگ
      if(hue!==0){
        const hsl=rgbToHsl(r,g,b);hsl[0]=(hsl[0]+hue+1)%1;const rgb=hslToRgb(hsl[0],hsl[1],hsl[2]);r=rgb[0];g=rgb[1];b=rgb[2];
      }
      
      // شدت رنگ
      if(vibrance!==0){
        const max=Math.max(r,g,b)/255;const fac=1+max*vibrance;r*=fac;g*=fac;b*=fac;
      }
      
      // دمای رنگ
      r+=temp*30;b-=temp*30;
      
      d[i]=Math.min(255,Math.max(0,r));d[i+1]=Math.min(255,Math.max(0,g));d[i+2]=Math.min(255,Math.max(0,b));
    }
    ctx.putImageData(im,0,0);
  }
  
  function rgbToHsl(r,g,b){r/=255;g/=255;b/=255;const m=Math.max(r,g,b),n=Math.min(r,g,b),l=(m+n)/2;let h=0,s=0;if(m!==n){const d=m-n;s=l>0.5?d/(2-m-n):d/(m+n);switch(m){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;case b:h=(r-g)/d+4;}h/=6;}return[h,s,l];}
  function hslToRgb(h,s,l){let r,g,b;if(s===0){r=g=b=l;}else{const q=l<0.5?l*(1+s):l+s-l*s,p=2*l-q;r=hue2rgb(p,q,h+1/3);g=hue2rgb(p,q,h);b=hue2rgb(p,q,h-1/3);}return[r*255,g*255,b*255];}
  function hue2rgb(p,q,t){if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p;}
  
  window.rotateScan=function(deg){SCANROTATE=(SCANROTATE+deg)%360;applyScan();};
  window.flipScan=function(dir){SCANFLIP[dir]=!SCANFLIP[dir];applyScan();};
  
  window.cropScan=function(){
    if(!SCANIMG){toast('ابتدا عکس را انتخاب کنید');return;}
    const cv=document.getElementById('scan-canvas');
    const ratio=Math.min(400/cv.width,400/cv.height);
    const tempCv=document.createElement('canvas');tempCv.width=cv.width;tempCv.height=cv.height;
    const tempCtx=tempCv.getContext('2d');tempCtx.drawImage(cv,0,0);
    const overlay=document.createElement('div');overlay.style='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center';
    const box=document.createElement('div');box.style='background:#fff;padding:20px;border-radius:16px;max-width:500px;width:90%';
    const preview=document.createElement('canvas');preview.id='crop-preview';preview.style='max-width:100%;border:2px solid #3b82f6;margin:12px 0';
    const info=document.createElement('p');info.style='text-align:center;color:#64748b;font-size:13px';
    const hint=document.createElement('p');hint.style='text-align:center;color:#374151;font-size:14px;margin-bottom:12px';
    hint.textContent='روی عکس کلیک و بکشید تا ناحیه برش را انتخاب کنید';
    let sel={x:50,y:50,w:300,h:200};
    preview.width=400;preview.height=300;
    const drawPreview=()=>{const ctx=preview.getContext('2d');ctx.drawImage(cv,0,0,400,300);ctx.fillStyle='rgba(59,130,246,0.3)';ctx.fillRect(sel.x,sel.y,sel.w,sel.h);ctx.strokeStyle='#3b82f6';ctx.lineWidth=2;ctx.strokeRect(sel.x,sel.y,sel.w,sel.h);};
    drawPreview();
    preview.onmousedown=e=>{const r=preview.getBoundingClientRect();sel.x=e.clientX-r.left-50;sel.y=e.clientY-r.top-30;sel.w=100;sel.h=60;preview.onmousemove=ev=>{const r2=preview.getBoundingClientRect();sel.w=Math.max(20,ev.clientX-r2.left-sel.x);sel.h=Math.max(20,ev.clientY-r2.top-sel.y);sel.w=Math.min(400-sel.x,sel.w);sel.h=Math.min(300-sel.y,sel.h);drawPreview();};};
    preview.onmouseup=()=>{preview.onmousemove=null;};
    const apply=document.createElement('button');apply.className='btn primary';apply.textContent='✓ اعمال برش';apply.style='margin-top:12px';apply.onclick=()=>{
      const rx=sel.x*cv.width/400,ry=sel.y*cv.height/300,rw=sel.w*cv.width/400,rh=sel.h*cv.height/300;
      const newCv=document.createElement('canvas');newCv.width=rw;newCv.height=rh;
      newCv.getContext('2d').drawImage(cv,rx,ry,rw,rh,0,0,rw,rh);
      const img=new Image();img.onload=()=>{SCANIMG=img;SCANROTATE=0;SCANFLIP={h:false,v:false};const tempDataUrl=tempCv.toDataURL();const origImg=new Image();origImg.onload=()=>{SCANIMG=origImg;applyScan();};origImg.src=tempDataUrl;};img.src=newCv.toDataURL();
      document.body.removeChild(overlay);applyScan();
    };
    const cancel=document.createElement('button');cancel.className='btn';cancel.textContent='انصراف';cancel.style='margin-top:12px;margin-right:8px';cancel.onclick=()=>document.body.removeChild(overlay);
    box.appendChild(hint);box.appendChild(preview);box.appendChild(info);box.appendChild(apply);box.appendChild(cancel);overlay.appendChild(box);document.body.appendChild(overlay);
    info.textContent=`ابعاد انتخاب‌شده: ${Math.round(sel.w*cv.width/400)} × ${Math.round(sel.h*cv.height/300)} پیکسل`;
  };
  
  document.getElementById('btn-dl-img').onclick=()=>{
    if(!SCANIMG){toast('ابتدا عکس را انتخاب کنید');return;}
    const cv=document.getElementById('scan-canvas');
    const a=document.createElement('a');a.href=cv.toDataURL('image/png');a.download='اسکن.png';document.body.appendChild(a);a.click();a.remove();
  };
  
  document.getElementById('btn-dl-jpg').onclick=()=>{
    if(!SCANIMG){toast('ابتدا عکس را انتخاب کنید');return;}
    const cv=document.getElementById('scan-canvas');
    const a=document.createElement('a');a.href=cv.toDataURL('image/jpeg',0.92);a.download='اسکن.jpg';document.body.appendChild(a);a.click();a.remove();
  };
  
  document.getElementById('btn-dl-pdf').onclick=()=>{
    if(!SCANIMG){toast('ابتدا عکس را انتخاب کنید');return;}
    if(!window.jspdf){toast('کتابخانه PDF در دسترس نیست');return;}
    const cv=document.getElementById('scan-canvas');
    const img=cv.toDataURL('image/jpeg',0.92);
    const jsPDF=window.jspdf.jsPDF;
    const pdf=new jsPDF({orientation:cv.width>=cv.height?'l':'p',unit:'pt',format:'a4'});
    const pw=pdf.internal.pageSize.getWidth(),ph=pdf.internal.pageSize.getHeight();
    const m=24,aw=pw-2*m,ah=ph-2*m;
    let iw=cv.width,ih=cv.height;const ratio=Math.min(aw/iw,ah/ih);iw*=ratio;ih*=ratio;
    pdf.addImage(img,'JPEG',(pw-iw)/2,(ph-ih)/2,iw,ih);
    pdf.save('اسکن.pdf');
  };

  // ---- کاهش حجم عکس ----
  let RESIZEIMG=null,ORIGW=0,ORIGH=0;
  
  document.getElementById('resize-file').addEventListener('change',function(){
    const f=this.files[0];if(!f)return;
    document.getElementById('resize-orig-size').textContent=(f.size/1024).toFixed(1)+' KB';
    const rd=new FileReader();
    rd.onload=ev=>{const img=new Image();img.onload=()=>{RESIZEIMG=img;ORIGW=img.width;ORIGH=img.height;document.getElementById('resize-orig-dims').textContent=ORIGW+' × '+ORIGH;document.getElementById('resize-width').value=ORIGW;document.getElementById('resize-height').value=ORIGH;document.getElementById('resize-controls').classList.remove('hidden');applyResize();};img.src=ev.target.result;};
    rd.readAsDataURL(f);
  });
  
  window.applyResize=function(){
    if(!RESIZEIMG)return;
    const cv=document.getElementById('resize-canvas');
    const ctx=cv.getContext('2d');
    let w=parseInt(document.getElementById('resize-width').value)||100;
    let h=parseInt(document.getElementById('resize-height').value)||100;
    if(document.getElementById('resize-ratio').checked){const ratio=ORIGW/ORIGH;if(w/ORIGW>h/ORIGH)w=Math.round(h*ratio);else h=Math.round(w/ratio);}
    w=Math.max(100,Math.min(4000,w));h=Math.max(100,Math.min(4000,h));
    cv.width=w;cv.height=h;ctx.drawImage(RESIZEIMG,0,0,w,h);
    document.getElementById('resize-new-dims').textContent=w+' × '+h;
    const qual=parseInt(document.getElementById('resize-quality').value)/100;
    const dataUrl=cv.toDataURL('image/jpeg',qual);
    const size=(dataUrl.length*0.75)/1024;
    document.getElementById('resize-new-size').textContent=size.toFixed(1)+' KB';
  };
  
  document.getElementById('btn-download-resized').onclick=()=>{
    if(!RESIZEIMG){toast('ابتدا عکس را انتخاب کنید');return;}
    const cv=document.getElementById('resize-canvas');
    const a=document.createElement('a');a.href=cv.toDataURL('image/jpeg',parseInt(document.getElementById('resize-quality').value)/100);a.download='عکس_کاهش_یافته.jpg';document.body.appendChild(a);a.click();a.remove();
    toast('عکس با موفقیت دانلود شد ✅');
  };

  // ---- تبدیل PDF به Word ----
  let PDFFILE=null;
  
  document.getElementById('pdf-file').addEventListener('change',async function(){
    const f=this.files[0];if(!f)return;
    PDFFILE=f;
    document.getElementById('pdf-name').textContent=f.name;
    document.getElementById('pdf-info').textContent=(f.size/1024).toFixed(1)+' KB';
    document.getElementById('pdf-controls').classList.remove('hidden');
    
    // بررسی وجود pdf.js
    if(!window.pdfjsLib){
      const script=document.createElement('script');
      script.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload=()=>{pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';};
      document.head.appendChild(script);
    }
    
    const pagesDiv=document.getElementById('pdf-pages');
    pagesDiv.innerHTML='<p style="color:#64748b">در حال بارگذاری صفحات...</p>';
    
    try{
      await new Promise(r=>setTimeout(r,1000));
      const arrayBuffer=await f.arrayBuffer();
      const pdf=await pdfjsLib.getDocument({data:arrayBuffer}).promise;
      const quality=parseInt(document.getElementById('pdf-quality').value);
      let html='<div style="direction:rtl;font-family:Tahoma,Arial,sans-serif">';
      
      for(let i=1;i<=Math.min(pdf.numPages,10);i++){
        const page=await pdf.getPage(i);
        const viewport=page.getViewport({scale:quality/72});
        const canvas=document.createElement('canvas');
        canvas.width=viewport.width;canvas.height=viewport.height;
        const ctx=canvas.getContext('2d');
        await page.render({canvasContext:ctx,viewport}).promise;
        html+=`<div style="page-break-after:always;margin-bottom:20px"><img src="${canvas.toDataURL('image/jpeg',0.9)}" style="width:100%;max-width:700px"></div>`;
        pagesDiv.innerHTML+=`<div style="flex:0 0 auto;width:80px;height:100px;border:2px solid #e2e8f0;border-radius:8px;overflow:hidden;margin:4px"><img src="${canvas.toDataURL('image/jpeg',0.5)}" style="width:100%;height:100%;object-fit:cover"><p style="text-align:center;font-size:10px;margin:2px 0">${i}</p></div>`;
      }
      html+='</div>';
      
      window.PDF_HTML=html;
      if(pdf.numPages>10)pagesDiv.innerHTML+=`<p style="color:#f59e0b;font-size:12px;width:100%">* فقط 10 صفحه اول نمایش داده شد</p>`;
    }catch(e){pagesDiv.innerHTML='<p style="color:#dc2626">خطا در بارگذاری PDF: '+e.message+'</p>';}
  });
  
  window.clearPdf=function(){PDFFILE=null;document.getElementById('pdf-controls').classList.add('hidden');document.getElementById('pdf-file').value='';};
  
  document.getElementById('btn-convert-pdf').onclick=async()=>{
    if(!PDFFILE||!window.PDF_HTML){toast('ابتدا فایل PDF را انتخاب کنید');return;}
    const html='<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>تبدیل از PDF</title></head><body>'+window.PDF_HTML+'</body></html>';
    const blob=new Blob(['\ufeff'+html],{type:'application/msword'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='تبدیل_از_PDF.doc';document.body.appendChild(a);a.click();a.remove();
    toast('فایل Word ساخته شد ✅');
  };

  checkAuth();
  `;
}
