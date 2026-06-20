/**
 * پنل آزمون ساز دوره ابتدایی
 * طراح: نادر اکشیک
 *
 * یک Cloudflare Worker کامل شامل:
 *  - صفحه آزمون دانش‌آموز (سربرگ، فرم اطلاعات، سوال امنیتی، نمایش نتیجه پس از تصحیح)
 *  - پنل معلم (ساخت دانش‌آموز با UUID اختصاصی، طراحی سوال، تصحیح و بازخورد، مشاهده پاسخنامه‌ها)
 *  - سوال تشریحی با امکان درج عکس، اشکال هندسی و علائم ریاضی
 *  - دانلود خروجی Word با سربرگ و جدول‌کشی
 *  - جدول‌ساز حرفه‌ای با خروجی اکسل RTL (با ExcelJS)
 *  - اسکنر حرفه‌ای (مشابه CamScanner) با فیلترهای متنوع
 *  - کاهش حجم عکس با تنظیم کیفیت
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

  // هوش مصنوعی Groq
  if (path === "/api/ai/chat" && method === "POST") {
    if (!(await isTeacher(req, env))) return json({ error: "دسترسی غیرمجاز" }, 401);
    const body = await req.json().catch(() => ({}));
    const messages = body.messages || [];
    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) return json({ error: "کلید GROQ_API_KEY تنظیم نشده" }, 500);
    try {
      const aiRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "system", content: "You are a helpful assistant for Iranian teachers. Always respond in Persian/Farsi." }, ...messages.slice(-10)],
          max_tokens: 1024
        })
      });
      if (!aiRes.ok) {
        const errText = await aiRes.text();
        return json({ error: "Groq: " + errText }, aiRes.status);
      }
      const aiData = await aiRes.json();
      return json({ ok: true, content: aiData.choices?.[0]?.message?.content || "" });
    } catch (e) {
      return json({ error: "Error: " + e.message }, 500);
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
  
  /* ---- جدول‌ساز جدید ---- */
  .section-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid var(--line)}
  .section-header h3{margin:0 0 4px;font-size:18px}
  .toolbar{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
  .toolbar .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;border-radius:12px;font-weight:600;font-size:14px}
  .btn.primary{background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff}
  .btn.primary:hover{background:linear-gradient(135deg,#4f46e5,#4338ca)}
  .btn.success{background:linear-gradient(135deg,#10b981,#059669);color:#fff}
  .btn.success:hover{background:linear-gradient(135deg,#059669,#047857)}
  .btn.secondary{background:#f1f5f9;color:#475569;border:1px solid #e2e8f0}
  .btn.secondary:hover{background:#e2e8f0}
  .btn.danger{background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff}
  .btn.danger:hover{background:linear-gradient(135deg,#dc2626,#b91c1c)}
  .table-rtl{direction:rtl;text-align:right;border-collapse:collapse;width:100%;margin-top:12px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  .table-rtl th,.table-rtl td{border:1px solid #e2e8f0;padding:12px 14px;font-size:14px}
  .table-rtl th{background:linear-gradient(135deg,#f8fafc,#f1f5f9);font-weight:600;color:#334155;text-align:center}
  .table-rtl td{background:#fff;text-align:right}
  .table-rtl tr:hover td{background:#f8fafc}
  .table-rtl td[contenteditable]{background:#fffef0;transition:background .2s}
  .table-rtl td[contenteditable]:focus{background:#fef9c3;outline:2px solid var(--primary-2)}
  .table-title-input{width:100%;padding:10px 12px;border:2px solid #e2e8f0;border-radius:10px;font-size:15px;font-weight:600;margin-bottom:10px;transition:border-color .2s}
  .table-title-input:focus{border-color:var(--primary-2);outline:none}
  .table-controls{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
  .table-controls input{width:80px;padding:6px 10px;border:1px solid #e2e8f0;border-radius:8px;text-align:center}
  .table-block{border:2px solid #e2e8f0;border-radius:16px;padding:20px;margin-bottom:16px;background:#fff}
  .table-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
  .table-num{font-size:16px;font-weight:700;color:#334155}
  .empty-state{text-align:center;padding:40px 20px;background:#f8fafc;border-radius:12px;border:2px dashed #cbd5e1}
  .empty-state p{color:#64748b;font-size:15px}
  
  /* ---- اسکنر حرفه‌ای ---- */
  .upload-zone{border:2px dashed #cbd5e1;border-radius:16px;padding:40px 20px;text-align:center;cursor:pointer;transition:all .3s;background:#fafbfc;margin-bottom:16px}
  .upload-zone:hover{border-color:var(--primary-2);background:#f0f4ff}
  .upload-zone.dragover{border-color:var(--primary);background:#eef2ff;transform:scale(1.02)}
  .upload-icon{font-size:48px;margin-bottom:12px}
  .upload-zone p{margin:0 0 6px;font-size:16px;font-weight:600;color:#334155}
  .filter-presets{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
  .filter-btn{padding:8px 16px;border:2px solid #e2e8f0;border-radius:10px;background:#fff;cursor:pointer;font-size:13px;font-weight:600;transition:all .2s}
  .filter-btn:hover{border-color:var(--primary-2);background:#f0f4ff}
  .filter-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .scan-settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:16px}
  .setting-group{background:#f8fafc;border-radius:12px;padding:14px;border:1px solid #e2e8f0}
  .setting-group label{display:block;font-weight:600;margin-bottom:8px;font-size:13px;color:#475569}
  .setting-group input[type=range]{width:100%;height:6px;-webkit-appearance:none;background:#e2e8f0;border-radius:3px;outline:none}
  .setting-group input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;background:var(--primary);border-radius:50%;cursor:pointer;box-shadow:0 2px 6px rgba(37,99,235,.3)}
  .setting-value{float:left;font-weight:700;color:var(--primary-2);font-size:14px;margin-top:4px}
  .scan-preview{background:#f1f5f9;border-radius:16px;padding:16px;text-align:center;overflow:auto;max-height:500px;border:1px solid #e2e8f0;margin-bottom:16px}
  .scan-preview canvas{max-width:100%;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.1)}
  .scan-toolbar{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  
  /* ---- کاهش حجم ---- */
  .resize-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;margin-bottom:16px}
  .resize-group{background:#f8fafc;border-radius:12px;padding:16px;border:1px solid #e2e8f0}
  .resize-group label{display:block;font-weight:600;margin-bottom:10px;font-size:14px;color:#334155}
  .size-inputs{display:flex;gap:12px;margin-bottom:10px}
  .input-with-label{display:flex;align-items:center;gap:6px}
  .input-with-label input{width:100px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:8px}
  .input-with-label input:focus{border-color:var(--primary-2);outline:none}
  .checkbox-label{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:normal}
  .quality-display{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
  #quality-percent{font-weight:700;color:var(--primary-2);font-size:18px}
  .format-options{display:flex;gap:8px}
  .format-btn{padding:8px 20px;border:2px solid #e2e8f0;border-radius:8px;background:#fff;cursor:pointer;font-weight:600;font-size:13px;transition:all .2s}
  .format-btn:hover{border-color:var(--primary-2)}
  .format-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .resize-preview{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:16px}
  .resize-item{position:relative;background:#f8fafc;border-radius:12px;padding:8px;border:1px solid #e2e8f0;text-align:center}
  .resize-item img{max-width:100%;max-height:120px;border-radius:8px}
  .resize-item .size-info{font-size:11px;color:#64748b;margin-top:6px}
  .resize-item .remove-btn{position:absolute;top:4px;left:4px;background:#fee2e2;color:#991b1b;border:none;border-radius:50%;width:24px;height:24px;cursor:pointer;font-size:14px}
  .resize-toolbar{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  
  /* ---- Crop ---- */
  .crop-area{background:#1e293b;border-radius:12px;padding:16px;margin:16px 0;display:flex;justify-content:center;overflow:hidden}
  #crop-wrapper{position:relative;display:inline-block;max-width:100%}
  #crop-img{max-width:100%;max-height:50vh;display:block}
  #crop-box{position:absolute;border:2px dashed #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.5);cursor:move;top:0;left:0}
  .crop-handle{position:absolute;width:12px;height:12px;background:#fff;border:2px solid #333;border-radius:50%}
  .crop-nw{top:-6px;left:-6px;cursor:nw-resize}
  .crop-n{top:-6px;left:50%;transform:translateX(-50%);cursor:n-resize}
  .crop-ne{top:-6px;right:-6px;cursor:ne-resize}
  .crop-w{top:50%;left:-6px;transform:translateY(-50%);cursor:w-resize}
  .crop-e{top:50%;right:-6px;transform:translateY(-50%);cursor:e-resize}
  .crop-sw{bottom:-6px;left:-6px;cursor:sw-resize}
  .crop-s{bottom:-6px;left:50%;transform:translateX(-50%);cursor:s-resize}
  .crop-se{bottom:-6px;right:-6px;cursor:se-resize}
  .crop-options{margin-bottom:12px}
  .crop-ratios{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .crop-ratios span{font-weight:600;font-size:14px}
  .ratio-btn{padding:6px 14px;border:2px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px}
  .ratio-btn:hover{border-color:var(--primary-2)}
  .ratio-btn.active{background:var(--primary);color:#fff;border-color:var(--primary)}
  .crop-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
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
        <div class="tab active" data-tab="students">👨‍🎓 دانش‌آموزان</div>
        <div class="tab" data-tab="questions">📝 طراحی سوالات</div>
        <div class="tab" data-tab="answers">✅ تصحیح</div>
        <div class="tab" data-tab="tables">📊 جدول‌ساز</div>
        <div class="tab" data-tab="scan">📷 اسکنر</div>
        <div class="tab" data-tab="resize">🗜️ کاهش حجم</div>
        <div class="tab" data-tab="crop">✂️ برش عکس</div>
        <div class="tab" data-tab="ai">🤖 هوش مصنوعی</div>
        <div class="tab" data-tab="settings">⚙️ تنظیمات</div>
        <div style="flex:1"></div>
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
        <div class="section-header">
          <div>
            <h3>📊 جدول‌ساز حرفه‌ای</h3>
            <p class="muted">جدول‌های زیبا و حرفه‌ای بسازید و با فرمت اکسل خروجی بگیرید</p>
          </div>
        </div>
        <div class="toolbar">
          <button class="btn primary" id="btn-add-table">
            <span>➕</span> افزودن جدول جدید
          </button>
          <button class="btn success" id="btn-dl-excel">
            <span>📥</span> دانلود اکسل
          </button>
        </div>
        <div id="tables-list"></div>
      </div>

      <!-- اسکنر عکس -->
      <div class="card tab-content hidden" id="tab-scan">
        <div class="section-header">
          <div>
            <h3>📷 اسکنر حرفه‌ای (مشابه CamScanner)</h3>
            <p class="muted">عکس‌های خود را با کیفیت بالا اسکن کنید</p>
          </div>
        </div>
        
        <div class="upload-zone" id="scan-drop-zone">
          <input type="file" accept="image/*" id="scan-file" class="hidden">
          <div class="upload-icon">📷</div>
          <p>عکس را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">فرمت‌های مجاز: JPG, PNG, WEBP</span>
        </div>
        
        <div id="scan-controls" class="hidden">
          <!-- فیلترهای سریع -->
          <div class="filter-presets">
            <button class="filter-btn active" data-filter="original">اصلی</button>
            <button class="filter-btn" data-filter="color">رنگی</button>
            <button class="filter-btn" data-filter="gray">خاکستری</button>
            <button class="filter-btn" data-filter="bw">سیاه/سفید</button>
            <button class="filter-btn" data-filter="document">سند</button>
            <button class="filter-btn" data-filter="enhance">بهبود</button>
          </div>
          
          <!-- تنظیمات دستی -->
          <div class="scan-settings">
            <div class="setting-group">
              <label>🔆 روشنایی</label>
              <input type="range" id="scan-bright" min="-100" max="100" value="0">
              <span class="setting-value" id="bright-val">0</span>
            </div>
            <div class="setting-group">
              <label>◐ کنتراست</label>
              <input type="range" id="scan-contrast" min="-50" max="50" value="0">
              <span class="setting-value" id="contrast-val">0</span>
            </div>
            <div class="setting-group">
              <label>🎯 وضوح</label>
              <input type="range" id="scan-sharp" min="0" max="100" value="0">
              <span class="setting-value" id="sharp-val">0</span>
            </div>
            <div class="setting-group">
              <label>🔵 اشباع رنگ</label>
              <input type="range" id="scan-saturation" min="-100" max="100" value="0">
              <span class="setting-value" id="saturation-val">0</span>
            </div>
          </div>
          
          <!-- پیش‌نمایش -->
          <div class="scan-preview">
            <canvas id="scan-canvas"></canvas>
          </div>
          
          <!-- نوار ابزار -->
          <div class="scan-toolbar">
            <button class="btn primary" id="btn-dl-img">
              <span>💾</span> دانلود عکس
            </button>
            <button class="btn success" id="btn-dl-pdf">
              <span>📄</span> دانلود PDF
            </button>
            <button class="btn secondary" id="btn-reset-scan">
              <span>🔄</span> بازنشانی
            </button>
            <button class="btn danger" id="btn-remove-scan">
              <span>🗑️</span> حذف عکس
            </button>
          </div>
        </div>
      </div>

      <!-- کاهش حجم عکس -->
      <div class="card tab-content hidden" id="tab-resize">
        <div class="section-header">
          <div>
            <h3>🗜️ کاهش حجم عکس</h3>
            <p class="muted">عکس‌ها را با کیفیت دلخواه فشرده کنید</p>
          </div>
        </div>
        
        <div class="upload-zone" id="resize-drop-zone">
          <input type="file" accept="image/*" id="resize-file" class="hidden" multiple>
          <div class="upload-icon">🖼️</div>
          <p>عکس را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">می‌توانید چند عکس انتخاب کنید</span>
        </div>
        
        <div id="resize-controls" class="hidden">
          <div class="resize-options">
            <div class="resize-group">
              <label>📊 کیفیت تصویر</label>
              <input type="range" id="resize-quality" min="10" max="100" value="85">
              <div class="quality-display">
                <span id="quality-percent">85%</span>
                <span class="muted" id="quality-estimate">حدود 500 کیلوبایت</span>
              </div>
            </div>
            
            <div class="resize-group">
              <label>📐 فرمت خروجی</label>
              <div class="format-options">
                <button class="format-btn active" data-format="jpeg">JPEG</button>
                <button class="format-btn" data-format="png">PNG</button>
                <button class="format-btn" data-format="webp">WEBP</button>
              </div>
            </div>
          </div>
          
          <div class="resize-preview" id="resize-preview"></div>
          
          <div class="resize-toolbar">
            <button class="btn primary" id="btn-resize-all">
              <span>⚡</span> فشرده‌سازی همه
            </button>
            <button class="btn secondary" id="btn-clear-resize">
              <span>🗑️</span> پاک کردن
            </button>
          </div>
        </div>
      </div>

      <!-- برش عکس -->
      <div class="card tab-content hidden" id="tab-crop">
        <div class="section-header">
          <div>
            <h3>✂️ برش عکس</h3>
            <p class="muted">عکس‌های خود را برش بزنید و دانلود کنید</p>
          </div>
        </div>
        
        <div class="upload-zone" id="crop-drop-zone">
          <input type="file" accept="image/*" id="crop-file" class="hidden">
          <div class="upload-icon">🖼️</div>
          <p>عکس را اینجا رها کنید یا کلیک کنید</p>
          <span class="muted">یک عکس برای برش انتخاب کنید</span>
        </div>
        
        <div id="crop-controls" class="hidden">
          <div class="crop-area">
            <div id="crop-wrapper">
              <img id="crop-img" src="" alt="برش">
              <div id="crop-box">
                <div class="crop-handle crop-nw"></div>
                <div class="crop-handle crop-n"></div>
                <div class="crop-handle crop-ne"></div>
                <div class="crop-handle crop-w"></div>
                <div class="crop-handle crop-e"></div>
                <div class="crop-handle crop-sw"></div>
                <div class="crop-handle crop-s"></div>
                <div class="crop-handle crop-se"></div>
              </div>
            </div>
          </div>
          <div class="crop-options">
            <div class="crop-ratios">
              <span>نسبت تصویر:</span>
              <button class="ratio-btn active" data-ratio="free">آزاد</button>
              <button class="ratio-btn" data-ratio="16:9">16:9</button>
              <button class="ratio-btn" data-ratio="4:3">4:3</button>
              <button class="ratio-btn" data-ratio="1:1">1:1</button>
              <button class="ratio-btn" data-ratio="3:4">3:4</button>
            </div>
          </div>
          <div class="crop-actions">
            <button class="btn danger" id="btn-crop-delete">
              <span>🗑️</span> حذف عکس
            </button>
            <button class="btn secondary" id="btn-crop-reset">
              <span>↩️</span> بازنشانی
            </button>
            <button class="btn primary" id="btn-crop-download">
              <span>💾</span> دانلود عکس
            </button>
          </div>
        </div>
      </div>

      <!-- هوش مصنوعی -->
      <div class="card tab-content hidden" id="tab-ai">
        <div class="section-header">
          <div>
            <h3>🤖 دستیار هوش مصنوعی</h3>
            <p class="muted">سوالات خود را بپرسید</p>
          </div>
        </div>
        <div id="ai-messages" class="ai-messages" style="min-height:200px;max-height:400px;overflow-y:auto;padding:10px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:10px"></div>
        <div class="flex gap-2">
          <input type="text" id="ai-input" placeholder="سوال خود را بنویسید..." style="flex:1">
          <button class="btn primary" id="btn-ai-send">ارسال</button>
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
  // AI Chat
  var aiMessages = [];
  document.getElementById('btn-ai-send').onclick=async()=>{
    const input = document.getElementById('ai-input');
    const text = input.value.trim();
    if (!text) return;
    aiMessages.push({role:'user', content:text});
    input.value = '';
    document.getElementById('ai-messages').innerHTML += '<div style="text-align:left;margin:5px 0"><b>شما:</b> '+esc(text)+'</div><div style="text-align:left;color:#666">...</div>';
    const box = document.getElementById('ai-messages');
    try {
      const res = await fetch('/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:aiMessages})});
      const d = await res.json();
      if (d.error) { alert(d.error); return; }
      aiMessages.push({role:'assistant', content:d.content});
      box.innerHTML = aiMessages.map(m=>'<div style="text-align:'+(m.role==='user'?'left':'right')+';margin:5px 0"><b>'+(m.role==='user'?'شما':'🤖')+':</b> '+esc(m.content)+'</div>').join('');
    } catch(e){ alert('خطا: '+e.message); }
    box.scrollTop = box.scrollHeight;
  };
  document.getElementById('ai-input').onkeydown=e=>{ if(e.key==='Enter') document.getElementById('btn-ai-send').click(); };

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
    if(!TABLES.length){box.innerHTML='<div class="empty-state"><p>هنوز جدولی ساخته نشده است</p></div>';return;}
    box.innerHTML=TABLES.map((t,ti)=>{
      let h='<div class="q-block table-block"><div class="table-header"><span class="table-num">جدول '+(ti+1)+'</span><button class="btn sm danger" onclick="delTable('+ti+')">🗑️ حذف</button></div>';
      h+='<input class="table-title-input" value="'+esc(t.title)+'" placeholder="موضوع جدول..." oninput="updTableTitle('+ti+',this.value)">';
      h+='<div class="table-controls"><label>سطر:</label><input type="number" min="1" max="60" value="'+t.rows+'" onchange="resizeTable('+ti+',\\'rows\\',this.value)"><label>ستون:</label><input type="number" min="1" max="20" value="'+t.cols+'" onchange="resizeTable('+ti+',\\'cols\\',this.value)"></div>';
      h+='<div style="overflow:auto"><table class="table-rtl">';
      for(let r=0;r<t.rows;r++){h+='<tr>';for(let c=0;c<t.cols;c++){h+='<td contenteditable="true" oninput="updCell('+ti+','+r+','+c+',this.innerText)">'+esc(t.data[r][c]||'')+'</td>';}h+='</tr>';}
      h+='</table></div></div>';
      return h;
    }).join('');
  };
  window.updTableTitle=(ti,v)=>{TABLES[ti].title=v;};
  window.updCell=(ti,r,c,v)=>{TABLES[ti].data[r][c]=v;};
  window.delTable=(ti)=>{if(!confirm('این جدول حذف شود؟'))return;TABLES.splice(ti,1);renderTables();};
  window.resizeTable=(ti,k,v)=>{const n=Math.max(1,parseInt(v,10)||1);const t=TABLES[ti];if(k==='rows')t.rows=n;else t.cols=n;t.data=blankRows(t.rows,t.cols,t.data);renderTables();};
  document.getElementById('btn-add-table').onclick=()=>{TABLES.push({title:'بانک سوالات',rows:4,cols:6,data:blankRows(4,6)});renderTables();};
  
  // رنگ‌بندی‌های جدول
  const COLOR_THEMES=[
    {name:'آبی',header:'4F46E5',band:'EEF2FF'},
    {name:'سبز',header:'059669',band:'ECFDF5'},
    {name:'نارنجی',header:'EA580C',band:'FFF7ED'},
    {name:'صورتی',header:'DB2777',band:'FDF2F8'},
    {name:'خاکستری',header:'334155',band:'F8FAFC'},
  ];
  let TABLE_THEME_IDX=0;
  
  document.getElementById('btn-dl-excel').onclick=()=>{
    if(!TABLES.length){toast('ابتدا یک جدول بسازید');return;}
    const theme=COLOR_THEMES[TABLE_THEME_IDX];
    
    // ساخت HTML با فرمت اکسل RTL
    let html='<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">';
    html+='<head><meta charset="utf-8"><x:ExcelNameList><x:Name>Sheet1</x:Name></x:ExcelNameList>';
    html+='<style>';
    html+='table{direction:rtl}';
    html+='.title{font-size:16pt;font-weight:bold;text-align:center;background:#4472C4;color:#fff;padding:10px}';
    html+='.header{font-size:12pt;font-weight:bold;text-align:center;background:#D9E2F3;color:#000;padding:8px;border:1px solid #B4C6E7}';
    html+='.cell{font-size:11pt;text-align:right;padding:6px;border:1px solid #B4C6E7}';
    html+='.row-even{background:#F2F2F2}';
    html+='</style></head><body>';

    TABLES.forEach((t,ti)=>{
      // عنوان
      html+='<table ss:Direction="RightToLeft"><tr><td class="title" colspan="'+t.cols+'">'+(t.title||'جدول '+(ti+1))+'</td></tr></table>';
      // هدر
      html+='<table ss:Direction="RightToLeft">';
      html+='<tr>';
      for(let c=0;c<t.cols;c++){
        html+='<td class="header">'+(c===0?'سوال':c===t.cols-1?'تایم':'گزینه '+(c))+'</td>';
      }
      html+='</tr>';
      // داده‌ها
      t.data.forEach((row,r)=>{
        html+='<tr'+(r%2===1?' class="row-even"':'')+'>';
        row.forEach((cell,c)=>{
          html+='<td class="cell">'+esc(cell||'')+'</td>';
        });
        for(let c=row.length;c<t.cols;c++){
          html+='<td class="cell"></td>';
        }
        html+='</tr>';
      });
      html+='</table><br>';
    });

    html+='</body></html>';
    const blob=new Blob(['\ufeff'+html],{type:'application/vnd.ms-excel'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='جداول.xls';document.body.appendChild(a);a.click();a.remove();
    toast('فایل اکسل با موفقیت ساخته شد ✅');
  };
  
  // دکمه‌های رنگ‌بندی
  const tableTools=document.querySelector('#tab-tables .table-actions');
  if(tableTools){
    tableTools.innerHTML+='<div style="margin-top:12px"><label style="font-size:13px">رنگ:</label>'+
      COLOR_THEMES.map((t,i)=>'<button class="btn sm '+(i===0?'primary':'secondary')+'" style="margin:2px" onclick="setTableTheme('+i+')">'+t.name+'</button>').join('')+
      '</div>';
  }
  window.setTableTheme=(i)=>{
    TABLE_THEME_IDX=i;
  };

  // ---- اسکنر عکس حرفه‌ای ----
  let SCANIMG=null, SCANORIG=null;
  
  // Drag and drop
  const scanDropZone=document.getElementById('scan-drop-zone');
  const scanFileInput=document.getElementById('scan-file');
  scanDropZone.onclick=()=>scanFileInput.click();
  scanDropZone.addEventListener('dragover',e=>{e.preventDefault();scanDropZone.classList.add('dragover');});
  scanDropZone.addEventListener('dragleave',()=>scanDropZone.classList.remove('dragover'));
  scanDropZone.addEventListener('drop',e=>{e.preventDefault();scanDropZone.classList.remove('dragover');if(e.dataTransfer.files[0])loadScanImg(e.dataTransfer.files[0]);});
  
  scanFileInput.addEventListener('change',function(){if(this.files[0])loadScanImg(this.files[0]);});
  
  function loadScanImg(file){
    const rd=new FileReader();
    rd.onload=ev=>{const img=new Image();img.onload=()=>{SCANIMG=img;SCANORIG=img;document.getElementById('scan-controls').classList.remove('hidden');scanDropZone.classList.add('hidden');applyScan();};img.src=ev.target.result;};
    rd.readAsDataURL(file);
  }
  
  // فیلترهای سریع
  const FILTERS={
    original:()=>{document.getElementById('scan-bright').value=0;document.getElementById('scan-contrast').value=0;document.getElementById('scan-saturation').value=0;document.getElementById('scan-sharp').value=0;},
    color:()=>{document.getElementById('scan-bright').value=5;document.getElementById('scan-contrast').value=10;document.getElementById('scan-saturation').value=15;document.getElementById('scan-sharp').value=20;},
    gray:()=>{document.getElementById('scan-bright').value=10;document.getElementById('scan-contrast').value=20;document.getElementById('scan-saturation').value=-100;document.getElementById('scan-sharp').value=30;},
    bw:()=>{document.getElementById('scan-bright').value=30;document.getElementById('scan-contrast').value=50;document.getElementById('scan-saturation').value=-100;document.getElementById('scan-sharp').value=40;},
    document:()=>{document.getElementById('scan-bright').value=20;document.getElementById('scan-contrast').value=40;document.getElementById('scan-saturation').value=-80;document.getElementById('scan-sharp').value=50;},
    enhance:()=>{document.getElementById('scan-bright').value=10;document.getElementById('scan-contrast').value=30;document.getElementById('scan-saturation').value=10;document.getElementById('scan-sharp').value=40;}
  };
  
  document.querySelectorAll('.filter-btn').forEach(btn=>{
    btn.onclick=()=>{
      document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      if(FILTERS[btn.dataset.filter])FILTERS[btn.dataset.filter]();
      updateFilterValues();
      applyScan();
    };
  });
  
  function updateFilterValues(){
    document.getElementById('bright-val').textContent=document.getElementById('scan-bright').value;
    document.getElementById('contrast-val').textContent=document.getElementById('scan-contrast').value;
    document.getElementById('sharp-val').textContent=document.getElementById('scan-sharp').value;
    document.getElementById('saturation-val').textContent=document.getElementById('scan-saturation').value;
  }
  
  ['scan-bright','scan-contrast','scan-sharp','scan-saturation'].forEach(id=>{
    const el=document.getElementById(id);
    if(el)el.addEventListener('input',()=>{updateFilterValues();applyScan();});
  });
  
  function applyScan(){
    if(!SCANORIG)return;
    const cv=document.getElementById('scan-canvas');const ctx=cv.getContext('2d');
    const mw=1400;let w=SCANORIG.width,h=SCANORIG.height;if(w>mw){h=Math.round(h*mw/w);w=mw;}
    cv.width=w;cv.height=h;ctx.drawImage(SCANORIG,0,0,w,h);
    
    const bright=parseInt(document.getElementById('scan-bright').value,10);
    const contrast=parseInt(document.getElementById('scan-contrast').value,10);
    const sharp=parseInt(document.getElementById('scan-sharp').value,10)/100;
    const sat=parseInt(document.getElementById('scan-saturation').value,10)/100+1;
    
    let im=ctx.getImageData(0,0,w,h);let d=im.data;
    
    // اشباع رنگ
    if(sat!==1){
      for(let p=0;p<d.length;p+=4){
        const gray=0.299*d[p]+0.587*d[p+1]+0.114*d[p+2];
        d[p]=Math.min(255,Math.max(0,gray+sat*(d[p]-gray)));
        d[p+1]=Math.min(255,Math.max(0,gray+sat*(d[p+1]-gray)));
        d[p+2]=Math.min(255,Math.max(0,gray+sat*(d[p+2]-gray)));
      }
      ctx.putImageData(im,0,0);
      im=ctx.getImageData(0,0,w,h);d=im.data;
    }
    
    // روشنایی و کنتراست
    const factor=(259*(contrast+255))/(255*(259-contrast));
    for(let p=0;p<d.length;p+=4){
      for(let c=0;c<3;c++){
        let val=d[p+c];
        val=factor*(val-128)+128+bright;
        d[p+c]=Math.min(255,Math.max(0,val));
      }
    }
    ctx.putImageData(im,0,0);
    
    // وضوح (Sharpen با Convolution)
    if(sharp>0){
      im=ctx.getImageData(0,0,w,h);
      const tmp=ctx.createImageData(w,h);
      const kernel=[0,-sharp,0,-sharp,1+4*sharp,-sharp,0,-sharp,0];
      for(let y=1;y<h-1;y++){
        for(let x=1;x<w-1;x++){
          for(let c=0;c<3;c++){
            let sum=0;
            for(let ky=-1;ky<=1;ky++){
              for(let kx=-1;kx<=1;kx++){
                const idx=((y+ky)*w+(x+kx))*4+c;
                sum+=im.data[idx]*kernel[(ky+1)*3+(kx+1)];
              }
            }
            tmp.data[(y*w+x)*4+c]=Math.min(255,Math.max(0,sum));
          }
          tmp.data[(y*w+x)*4+3]=255;
        }
      }
      ctx.putImageData(tmp,0,0);
    }
  }
  
  document.getElementById('btn-reset-scan').onclick=()=>{
    SCANORIG=SCANIMG;
    document.getElementById('scan-bright').value=0;
    document.getElementById('scan-contrast').value=0;
    document.getElementById('scan-sharp').value=0;
    document.getElementById('scan-saturation').value=0;
    updateFilterValues();
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    document.querySelector('.filter-btn[data-filter="original"]').classList.add('active');
    applyScan();
  };
  
  // حذف عکس و برگشت به حالت اولیه
  document.getElementById('btn-remove-scan').onclick=()=>{
    if(!confirm('عکس فعلی حذف شود؟'))return;
    SCANIMG=null;
    SCANORIG=null;
    document.getElementById('scan-controls').classList.add('hidden');
    document.getElementById('scan-drop-zone').classList.remove('hidden');
    document.getElementById('scan-file').value='';
    // ریست فیلترها
    document.getElementById('scan-bright').value=0;
    document.getElementById('scan-contrast').value=0;
    document.getElementById('scan-sharp').value=0;
    document.getElementById('scan-saturation').value=0;
    updateFilterValues();
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    document.querySelector('.filter-btn[data-filter="original"]').classList.add('active');
  };
  
  document.getElementById('btn-dl-img').onclick=()=>{
    if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}
    const cv=document.getElementById('scan-canvas');
    cv.toBlob(blob=>{
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='اسکن.png';document.body.appendChild(a);a.click();a.remove();
    },'image/png');
  };
  
  document.getElementById('btn-dl-pdf').onclick=()=>{
    if(!SCANORIG){toast('ابتدا عکس را انتخاب کنید');return;}
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
    toast('فایل PDF ساخته شد ✅');
  };

  // ---- کاهش حجم عکس ----
  let RESIZE_IMAGES=[];
  const resizeDropZone=document.getElementById('resize-drop-zone');
  const resizeFileInput=document.getElementById('resize-file');
  resizeDropZone.onclick=()=>resizeFileInput.click();
  resizeDropZone.addEventListener('dragover',e=>{e.preventDefault();resizeDropZone.classList.add('dragover');});
  resizeDropZone.addEventListener('dragleave',()=>resizeDropZone.classList.remove('dragover'));
  resizeDropZone.addEventListener('drop',e=>{e.preventDefault();resizeDropZone.classList.remove('dragover');handleResizeFiles(e.dataTransfer.files);});
  resizeFileInput.addEventListener('change',function(){handleResizeFiles(this.files);});
  
  function handleResizeFiles(files){
    Array.from(files).forEach(file=>{
      const rd=new FileReader();
      rd.onload=ev=>{
        const img=new Image();
        img.onload=()=>{
          RESIZE_IMAGES.push({file,img,original:ev.target.result});
          document.getElementById('resize-controls').classList.remove('hidden');
          renderResizePreview();
        };
        img.src=ev.target.result;
      };
      rd.readAsDataURL(file);
    });
  }
  
  function renderResizePreview(){
    const box=document.getElementById('resize-preview');
    if(!RESIZE_IMAGES.length){box.innerHTML='';return;}
    box.innerHTML=RESIZE_IMAGES.map((r,i)=>{
      const origSize=(r.file.size/1024).toFixed(1);
      return '<div class="resize-item"><button class="remove-btn" onclick="removeResizeImg('+i+')">×</button><img src="'+r.original+'" alt=""><div class="size-info">'+origSize+' KB</div></div>';
    }).join('');
  }
  window.removeResizeImg=(i)=>{RESIZE_IMAGES.splice(i,1);renderResizePreview();if(!RESIZE_IMAGES.length)document.getElementById('resize-controls').classList.add('hidden');};
  
  // Quality estimate
  document.getElementById('resize-quality').addEventListener('input',function(){
    const q=parseInt(this.value,10);
    document.getElementById('quality-percent').textContent=q+'%';
    const avgSize=RESIZE_IMAGES.length?RESIZE_IMAGES.reduce((s,r)=>s+r.file.size,0)/RESIZE_IMAGES.length:500000;
    const est=Math.round(avgSize*(q/100));
    document.getElementById('quality-estimate').textContent='حدود '+(est/1024).toFixed(0)+' KB';
  });
  
  // Format selection
  document.querySelectorAll('.format-btn').forEach(btn=>{
    btn.onclick=()=>{document.querySelectorAll('.format-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');};
  });
  
  document.getElementById('btn-resize-all').onclick=()=>{
    if(!RESIZE_IMAGES.length){toast('ابتدا عکس انتخاب کنید');return;}
    const q=parseInt(document.getElementById('resize-quality').value,10)/100;
    const fmt=document.querySelector('.format-btn.active').dataset.format;
    const mime=fmt==='png'?'image/png':fmt==='webp'?'image/webp':'image/jpeg';
    const ext=fmt==='png'?'png':fmt==='webp'?'webp':'jpg';
    
    RESIZE_IMAGES.forEach((r,i)=>{
      // حفظ اندازه اصلی عکس
      const cv=document.createElement('canvas');
      cv.width=r.img.width;
      cv.height=r.img.height;
      const ctx=cv.getContext('2d');
      ctx.drawImage(r.img,0,0);
      cv.toBlob(blob=>{
        const a=document.createElement('a');
        a.href=URL.createObjectURL(blob);
        a.download='عکس_'+(i+1)+'_فشرده.'+ext;
        document.body.appendChild(a);a.click();a.remove();
      },mime,q);
    });
    toast('عکس‌ها با موفقیت فشرده شدند ✅');
  };
  
  document.getElementById('btn-clear-resize').onclick=()=>{
    RESIZE_IMAGES=[];
    renderResizePreview();
    document.getElementById('resize-controls').classList.add('hidden');
  };

  // ---- Crop Tab ----
  let cropImg=null;
  let cropFileName='';
  let cropState={x:0,y:0,w:0,h:0,ratio:'free',dragging:false,resizing:false,handle:''};

  const cropDropZone=document.getElementById('crop-drop-zone');
  const cropFileInput=document.getElementById('crop-file');
  const cropControls=document.getElementById('crop-controls');

  cropDropZone.addEventListener('click',()=>cropFileInput.click());
  cropDropZone.addEventListener('dragover',e=>{e.preventDefault();cropDropZone.style.borderColor='var(--primary)';});
  cropDropZone.addEventListener('dragleave',()=>cropDropZone.style.borderColor='');
  cropDropZone.addEventListener('drop',e=>{e.preventDefault();cropDropZone.style.borderColor='';if(e.dataTransfer.files[0])loadCropImg(e.dataTransfer.files[0]);});
  cropFileInput.addEventListener('change',function(){if(this.files[0])loadCropImg(this.files[0]);});

  function loadCropImg(file){
    if(!file.type.startsWith('image/')){toast('فقط عکس مجاز است');return;}
    cropFileName=file.name;
    const rd=new FileReader();
    rd.onload=ev=>{
      const img=document.getElementById('crop-img');
      img.onload=()=>{
        const maxW=Math.min(img.naturalWidth,800);
        const scale=maxW/img.naturalWidth;
        img.style.width=maxW+'px';
        img.style.height=(img.naturalHeight*scale)+'px';
        document.getElementById('crop-wrapper').style.width=maxW+'px';
        document.getElementById('crop-wrapper').style.height=(img.naturalHeight*scale)+'px';
        cropImg={el:img,natW:img.naturalWidth,natH:img.naturalHeight};
        initCropBox();
      };
      img.src=ev.target.result;
      cropControls.classList.remove('hidden');
      cropDropZone.classList.add('hidden');
    };
    rd.readAsDataURL(file);
  }

  function initCropBox(){
    const img=document.getElementById('crop-img');
    const w=parseFloat(img.style.width);
    const h=parseFloat(img.style.height);
    const box=document.getElementById('crop-box');
    cropState.x=w*0.1;
    cropState.y=h*0.1;
    cropState.w=w*0.8;
    cropState.h=h*0.8;
    cropState.ratio='free';
    box.style.left=cropState.x+'px';
    box.style.top=cropState.y+'px';
    box.style.width=cropState.w+'px';
    box.style.height=cropState.h+'px';
  }

  document.getElementById('btn-crop-delete').onclick=()=>{
    cropImg=null;
    cropFileName='';
    cropControls.classList.add('hidden');
    cropDropZone.classList.remove('hidden');
    document.getElementById('crop-img').src='';
  };
  document.getElementById('btn-crop-reset').onclick=()=>initCropBox();

  document.querySelectorAll('.ratio-btn').forEach(btn=>{
    btn.onclick=()=>{
      document.querySelectorAll('.ratio-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      cropState.ratio=btn.dataset.ratio;
      applyRatio();
    };
  });

  function applyRatio(){
    if(cropState.ratio==='free')return;
    const [rw,rh]=cropState.ratio.split(':').map(Number);
    const ratio=rw/rh;
    const curRatio=cropState.w/cropState.h;
    if(curRatio>ratio){
      cropState.w=cropState.h*ratio;
    }else{
      cropState.h=cropState.w/ratio;
    }
    const wrapper=document.getElementById('crop-wrapper');
    const w=parseFloat(wrapper.style.width);
    const h=parseFloat(wrapper.style.height);
    cropState.x=Math.max(0,(w-cropState.w)/2);
    cropState.y=Math.max(0,(h-cropState.h)/2);
    updateCropBox();
  }

  function updateCropBox(){
    const box=document.getElementById('crop-box');
    box.style.left=cropState.x+'px';
    box.style.top=cropState.y+'px';
    box.style.width=cropState.w+'px';
    box.style.height=cropState.h+'px';
  }

  document.getElementById('btn-crop-download').onclick=()=>{
    if(!cropImg){toast('عکسی انتخاب نشده');return;}
    const img=cropImg.el;
    const sx=cropState.x*(img.naturalWidth/parseFloat(img.style.width));
    const sy=cropState.y*(img.naturalHeight/parseFloat(img.style.height));
    const sw=cropState.w*(img.naturalWidth/parseFloat(img.style.width));
    const sh=cropState.h*(img.naturalHeight/parseFloat(img.style.height));
    const canvas=document.createElement('canvas');
    canvas.width=sw;
    canvas.height=sh;
    const ctx=canvas.getContext('2d');
    ctx.drawImage(img,sx,sy,sw,sh,0,0,sw,sh);
    const a=document.createElement('a');
    a.href=canvas.toDataURL('image/png');
    a.download=cropFileName.replace(/\.[^.]+$/,'_cropped.png');
    a.click();
    toast('عکس برش‌خورده دانلود شد ✅');
  };

  // Drag & Resize
  const cropBox=document.getElementById('crop-box');
  cropBox.addEventListener('mousedown',e=>{
    if(e.target.classList.contains('crop-handle')){
      cropState.resizing=true;
      cropState.handle=e.target.className.replace('crop-handle crop-','');
    }else{
      cropState.dragging=true;
    }
    cropState.startX=e.clientX;
    cropState.startY=e.clientY;
    e.preventDefault();
  });

  document.addEventListener('mousemove',e=>{
    if(!cropState.dragging&&!cropState.resizing)return;
    const dx=e.clientX-cropState.startX;
    const dy=e.clientY-cropState.startY;
    cropState.startX=e.clientX;
    cropState.startY=e.clientY;
    const wrapper=document.getElementById('crop-wrapper');
    const w=parseFloat(wrapper.style.width);
    const h=parseFloat(wrapper.style.height);
    if(cropState.dragging){
      cropState.x=Math.max(0,Math.min(w-cropState.w,cropState.x+dx));
      cropState.y=Math.max(0,Math.min(h-cropState.h,cropState.y+dy));
    }else if(cropState.resizing){
      const rh=cropState.handle;
      if(rh.includes('e'))cropState.w=Math.max(50,Math.min(w-cropState.x,cropState.w+dx));
      if(rh.includes('w')){cropState.w=Math.max(50,cropState.w-dx);cropState.x+=dx;}
      if(rh.includes('s'))cropState.h=Math.max(50,Math.min(h-cropState.y,cropState.h+dy));
      if(rh.includes('n')){cropState.h=Math.max(50,cropState.h-dy);cropState.y+=dy;}
      if(cropState.ratio!=='free')applyRatio();
    }
    updateCropBox();
  });

  document.addEventListener('mouseup',()=>{cropState.dragging=false;cropState.resizing=false;});

  checkAuth();
  `;
}