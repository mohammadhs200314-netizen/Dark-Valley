/**
 * Dark Valley API v4 — Cloudflare Worker (aligned with frontend index + schema.sql)
 *
 * Bindings: DB (D1), AUDIO (R2), ROOMS (Durable Object class Room)
 * Vars: ALLOWED_ORIGINS, USER_UPLOAD_QUOTA_MB
 * Secrets: ADMIN_SETUP_TOKEN
 *
 * Auth: HttpOnly cookie `dv_session` (credentials: include) + optional Bearer token
 */

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.current = { songId: null, playing: false, time: 0, updatedAt: 0 };
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      this.sessions.set(server, { userId: "guest", joinedAt: Date.now() });
      server.send(JSON.stringify({ type: "state", ...this.current }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("Room DO", { status: 200 });
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    const session = this.sessions.get(ws) || { userId: "guest" };

    if (data.type === "join") {
      session.userId = data.userId || "guest";
      this.sessions.set(ws, session);
      ws.send(JSON.stringify({ type: "state", ...this.current }));
      return;
    }

    if (["play", "pause", "seek", "state"].includes(data.type)) {
      if (data.type === "play" || data.type === "state") {
        this.current.songId = data.songId || this.current.songId;
        this.current.playing = data.playing !== false;
        if (Number.isFinite(data.time)) this.current.time = data.time;
        this.current.updatedAt = Date.now();
      } else if (data.type === "pause") {
        this.current.playing = false;
        this.current.updatedAt = Date.now();
      } else if (data.type === "seek" && Number.isFinite(data.time)) {
        this.current.time = data.time;
        this.current.updatedAt = Date.now();
      }

      const payload = JSON.stringify({
        type: data.type,
        songId: this.current.songId,
        playing: this.current.playing,
        time: this.current.time,
        from: session.userId,
      });

      for (const [peer] of this.sessions) {
        try {
          if (peer !== ws && peer.readyState === 1) peer.send(payload);
        } catch {}
      }
    }
  }

  async webSocketClose(ws) {
    this.sessions.delete(ws);
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
  }
}

const encoder = new TextEncoder();
const COOKIE_NAME = "dv_session";
const SESSION_DAYS = 30;

function now() {
  return Math.floor(Date.now() / 1000);
}

function uid() {
  return crypto.randomUUID().replace(/-/g, "");
}

function token() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  return sha256(salt + ":" + password);
}

function randomSalt() {
  return token().slice(0, 24);
}

function bytes(n) {
  return Number(n) || 0;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin") || "";
  const list = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length || list.includes("*")) {
    return origin || "*";
  }
  if (origin && list.includes(origin)) return origin;
  return list[0];
}

function corsHeaders(origin) {
  const headers = {
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,x-admin-token",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (origin && origin !== "*") {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-credentials"] = "true";
  } else {
    headers["access-control-allow-origin"] = "*";
  }
  return headers;
}

function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function sessionCookie(rawToken, maxAgeSec) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    "HttpOnly",
    "Secure",
    "SameSite=None",
  ].join("; ");
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`;
}

function json(data, status = 200, { origin, setCookie } = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(origin),
  };
  if (setCookie) headers["set-cookie"] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}

function err(message, status = 400, origin) {
  return json({ error: message }, status, { origin });
}

function publicSong(row, requestUrl) {
  if (!row) return null;
  const base = new URL(requestUrl).origin;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    genre: row.genre,
    description: row.description || "",
    mime_type: row.mime_type || null,
    created_at: row.created_at ? row.created_at * 1000 : null,
    published: row.published,
    play_count: row.play_count,
    cover_key: row.cover_key || null,
    coverUrl: row.cover_key ? `${base}/api/cover/${encodeURIComponent(row.id)}` : "",
  };
}

async function getSession(request, env) {
  let raw = null;
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) raw = m[1].trim();
  if (!raw) {
    const cookies = parseCookies(request);
    raw = cookies[COOKIE_NAME] || null;
  }
  if (!raw) return null;

  const tokenHash = await sha256(raw);
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.user_id, s.expires_at, u.id, u.name, u.email, u.role, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  )
    .bind(tokenHash, now())
    .first();
  if (!row) return null;
  return {
    rawToken: raw,
    tokenHash,
    user: {
      id: row.user_id,
      name: row.name,
      email: row.email,
      role: row.role,
      created_at: row.created_at,
    },
  };
}

async function requireUser(request, env) {
  const s = await getSession(request, env);
  if (!s) throw { status: 401, message: "نیاز به ورود دارید" };
  return s;
}

async function requireAdmin(request, env) {
  const s = await requireUser(request, env);
  if (s.user.role !== "admin") throw { status: 403, message: "دسترسی مدیر لازم است" };
  return s;
}

async function getActiveTier(env, userId) {
  const row = await env.DB.prepare(
    `SELECT tier, status, expires_at FROM subscriptions
     WHERE user_id = ? AND status = 'active'
     ORDER BY CASE tier WHEN 'diamond' THEN 3 WHEN 'gold' THEN 2 ELSE 1 END DESC
     LIMIT 1`
  )
    .bind(userId)
    .first();
  if (!row) return { tier: "free", active: true, expiresAt: null };
  if (row.expires_at && row.expires_at < now()) {
    return { tier: "free", active: false, expiresAt: row.expires_at };
  }
  return {
    tier: row.tier || "free",
    active: true,
    expiresAt: row.expires_at || null,
  };
}

function playlistCap(tier) {
  return { free: 10, gold: 20, diamond: 50 }[tier] || 10;
}

function dailyUploadCap(tier) {
  return tier === "gold" || tier === "diamond" ? 5 : 2;
}

async function ensureUserProfile(env, userId) {
  const t = now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO user_profiles(user_id, created_at, updated_at) VALUES(?,?,?)`
  )
    .bind(userId, t, t)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO subscriptions(id, user_id, tier, status, starts_at, expires_at, source, created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  )
    .bind(uid(), userId, "free", "active", t, null, "auto", t)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO user_wallets(user_id, points, updated_at) VALUES(?,?,?)`
  )
    .bind(userId, 0, t)
    .run();
}

async function awardXP(env, userId, eventKey, xp) {
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO xp_events(id, user_id, event_key, xp, created_at) VALUES(?,?,?,?,?)`
    )
      .bind(uid(), userId, eventKey, xp, now())
      .run();
  } catch {}
}

function levelFromXP(xp) {
  let level = 1;
  let need = 100;
  let remaining = xp;
  while (remaining >= need) {
    remaining -= need;
    level += 1;
    need = Math.floor(100 * Math.pow(level, 1.35));
  }
  const progress = need ? Math.floor((remaining / need) * 100) : 0;
  const titles = [
    "تازه‌وارد",
    "شنونده",
    "کاشف",
    "عاشق دره",
    "نگهبان شب",
    "سایه‌بان",
    "استاد سکوت",
    "فرمانروای دره",
  ];
  const title = titles[Math.min(level - 1, titles.length - 1)] || "افسانه";
  return { level, xp, nextLevelXP: need, progress, title };
}

async function buildQuota(env, userId) {
  const tierInfo = await getActiveTier(env, userId);
  const maxUploads = dailyUploadCap(tierInfo.tier);
  const dayStart = now() - 86400;
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND submitted_at > ?`
  )
    .bind(userId, dayStart)
    .first();
  const usedRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(storage_bytes),0) as used FROM submissions WHERE user_id = ? AND status != 'rejected'`
  )
    .bind(userId)
    .first();
  const quotaMb = Number(env.USER_UPLOAD_QUOTA_MB || 100);
  const quotaBytes = quotaMb * 1024 * 1024;
  const usedBytes = bytes(usedRow?.used);
  return {
    tier: tierInfo.tier,
    maxUploads,
    remainingUploads: Math.max(0, maxUploads - (countRow?.c || 0)),
    usedBytes,
    quotaBytes,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
  };
}

async function createSession(env, userId) {
  const sessionToken = token();
  const tokenHash = await sha256(sessionToken);
  const expires = now() + SESSION_DAYS * 86400;
  await env.DB.prepare(`INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)`)
    .bind(tokenHash, userId, expires)
    .run();
  return { sessionToken, expires };
}

async function handleRequest(request, env, ctx) {
  const origin = allowedOrigin(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const url = new URL(request.url);
  let path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (path === "/" || path === "/health" || path === "/api/health") {
      return json({ ok: true, service: "dark-valley-api-v4", version: "4.0.1", ts: now() }, 200, {
        origin,
      });
    }

    if (!path.startsWith("/api")) {
      return err("Not found", 404, origin);
    }

    if (path === "/api/register" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (name.length < 2 || !email.includes("@") || password.length < 6) {
        return err("نام، ایمیل یا رمز عبور معتبر نیست", 400, origin);
      }
      const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
      if (existing) return err("این ایمیل قبلاً ثبت شده", 409, origin);

      const id = uid();
      const salt = randomSalt();
      const password_hash = await hashPassword(password, salt);
      const t = now();
      let role = "user";

      const setup =
        body.adminSetupToken ||
        body.setupToken ||
        request.headers.get("x-admin-token") ||
        "";
      if (setup && env.ADMIN_SETUP_TOKEN && setup === env.ADMIN_SETUP_TOKEN) {
        role = "admin";
      }

      await env.DB.prepare(
        `INSERT INTO users(id, name, email, salt, password_hash, role, created_at) VALUES(?,?,?,?,?,?,?)`
      )
        .bind(id, name, email, salt, password_hash, role, t)
        .run();
      await ensureUserProfile(env, id);

      const { sessionToken, expires } = await createSession(env, id);
      await awardXP(env, id, "register", 20);

      return json(
        { token: sessionToken, user: { id, name, email, role } },
        201,
        { origin, setCookie: sessionCookie(sessionToken, expires - now()) }
      );
    }

    if (path === "/api/login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const user = await env.DB.prepare(
        `SELECT id, name, email, salt, password_hash, role FROM users WHERE email = ?`
      )
        .bind(email)
        .first();
      if (!user) return err("ایمیل یا رمز عبور اشتباه است", 401, origin);
      const hash = await hashPassword(password, user.salt);
      if (hash !== user.password_hash) return err("ایمیل یا رمز عبور اشتباه است", 401, origin);

      await ensureUserProfile(env, user.id);
      const { sessionToken, expires } = await createSession(env, user.id);
      const dayKey = "daily_login_" + new Date().toISOString().slice(0, 10);
      await awardXP(env, user.id, dayKey, 10);

      return json(
        {
          token: sessionToken,
          user: { id: user.id, name: user.name, email: user.email, role: user.role },
        },
        200,
        { origin, setCookie: sessionCookie(sessionToken, expires - now()) }
      );
    }

    if (path === "/api/me" && request.method === "GET") {
      const s = await getSession(request, env);
      if (!s) return json({ user: null }, 200, { origin });
      const tierInfo = await getActiveTier(env, s.user.id);
      return json({ user: { ...s.user, tier: tierInfo.tier } }, 200, { origin });
    }

    if (path === "/api/logout" && request.method === "POST") {
      const s = await getSession(request, env);
      if (s) {
        await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(s.tokenHash).run();
      }
      return json({ ok: true }, 200, { origin, setCookie: clearSessionCookie() });
    }

    if (path === "/api/songs" && request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT id, title, artist, genre, description, cover_key, mime_type, created_at, published
         FROM songs WHERE published = 1 ORDER BY created_at DESC LIMIT 500`
      ).all();
      const songs = (rows.results || []).map((r) => publicSong(r, request.url));
      return json({ songs }, 200, { origin });
    }

    if (path === "/api/stream-url" && request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return err("id required", 400, origin);
      const song = await env.DB.prepare(
        `SELECT id, audio_key, mime_type, published FROM songs WHERE id = ?`
      )
        .bind(id)
        .first();
      if (!song || !song.published) return err("آهنگ پیدا نشد", 404, origin);

      try {
        await env.DB.prepare(
          `INSERT INTO song_stats(song_id, play_count, updated_at) VALUES(?,1,?)
           ON CONFLICT(song_id) DO UPDATE SET play_count = play_count + 1, updated_at = excluded.updated_at`
        )
          .bind(id, now())
          .run();
      } catch {}

      const s = await getSession(request, env);
      if (s) {
        const dayKey = "play_" + id + "_" + new Date().toISOString().slice(0, 10);
        await awardXP(env, s.user.id, dayKey, 2);
      }

      const absolute = new URL(`/api/stream/${encodeURIComponent(id)}`, url.origin).toString();
      return json({ url: absolute, mime: song.mime_type || "audio/mpeg" }, 200, { origin });
    }

    if (path.startsWith("/api/stream/") && request.method === "GET") {
      const id = decodeURIComponent(path.slice("/api/stream/".length));
      const song = await env.DB.prepare(
        `SELECT audio_key, mime_type, published FROM songs WHERE id = ?`
      )
        .bind(id)
        .first();
      if (!song || !song.published) return err("Not found", 404, origin);
      const obj = await env.AUDIO.get(song.audio_key);
      if (!obj) return err("File missing", 404, origin);
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("content-type", song.mime_type || "audio/mpeg");
      headers.set("cache-control", "public, max-age=3600");
      headers.set("accept-ranges", "bytes");
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => headers.set(k, v));
      return new Response(obj.body, { status: 200, headers });
    }

    if (path.startsWith("/api/cover/") && request.method === "GET") {
      const id = decodeURIComponent(path.slice("/api/cover/".length));
      const song = await env.DB.prepare(`SELECT cover_key FROM songs WHERE id = ?`).bind(id).first();
      if (!song || !song.cover_key) return err("No cover", 404, origin);
      const obj = await env.AUDIO.get(song.cover_key);
      if (!obj) return err("File missing", 404, origin);
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("cache-control", "public, max-age=86400");
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => headers.set(k, v));
      return new Response(obj.body, { status: 200, headers });
    }

    if (path === "/api/favorites" && request.method === "GET") {
      const s = await requireUser(request, env);
      const rows = await env.DB.prepare(
        `SELECT so.id, so.title, so.artist, so.genre, so.cover_key, so.mime_type, so.created_at, so.published
         FROM favorites f JOIN songs so ON so.id = f.song_id
         WHERE f.user_id = ? ORDER BY f.created_at DESC`
      )
        .bind(s.user.id)
        .all();
      return json(
        { songs: (rows.results || []).map((r) => publicSong(r, request.url)) },
        200,
        { origin }
      );
    }

    if (path === "/api/favorites" && request.method === "POST") {
      const s = await requireUser(request, env);
      const body = await request.json().catch(() => ({}));
      const songId = body.songId;
      if (!songId) return err("songId required", 400, origin);
      const exists = await env.DB.prepare(`SELECT id FROM songs WHERE id = ? AND published = 1`)
        .bind(songId)
        .first();
      if (!exists) return err("آهنگ معتبر نیست", 404, origin);
      const already = await env.DB.prepare(
        `SELECT 1 FROM favorites WHERE user_id = ? AND song_id = ?`
      )
        .bind(s.user.id, songId)
        .first();
      if (already) {
        await env.DB.prepare(`DELETE FROM favorites WHERE user_id = ? AND song_id = ?`)
          .bind(s.user.id, songId)
          .run();
        return json({ favorited: false }, 200, { origin });
      }
      await env.DB.prepare(`INSERT INTO favorites(user_id, song_id, created_at) VALUES(?,?,?)`)
        .bind(s.user.id, songId, now())
        .run();
      return json({ favorited: true }, 200, { origin });
    }

    if (path === "/api/song-likes" && request.method === "POST") {
      const s = await requireUser(request, env);
      const body = await request.json().catch(() => ({}));
      const songId = body.songId;
      if (!songId) return err("songId required", 400, origin);
      const already = await env.DB.prepare(
        `SELECT 1 FROM song_likes WHERE user_id = ? AND song_id = ?`
      )
        .bind(s.user.id, songId)
        .first();
      if (already) {
        await env.DB.prepare(`DELETE FROM song_likes WHERE user_id = ? AND song_id = ?`)
          .bind(s.user.id, songId)
          .run();
        return json({ liked: false }, 200, { origin });
      }
      await env.DB.prepare(`INSERT INTO song_likes(user_id, song_id, created_at) VALUES(?,?,?)`)
        .bind(s.user.id, songId, now())
        .run();
      return json({ liked: true }, 200, { origin });
    }

    if (path === "/api/comments" && request.method === "GET") {
      const songId = url.searchParams.get("songId");
      if (!songId) return err("songId required", 400, origin);
      const rows = await env.DB.prepare(
        `SELECT c.id, c.body, c.created_at, u.name as user_name, u.id as user_id,
                (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) as like_count
         FROM comments c JOIN users u ON u.id = c.user_id
         WHERE c.song_id = ? ORDER BY c.created_at DESC LIMIT 200`
      )
        .bind(songId)
        .all();
      const comments = (rows.results || []).map((c) => ({
        ...c,
        created_at: c.created_at ? c.created_at * 1000 : null,
      }));
      return json({ comments }, 200, { origin });
    }

    if (path === "/api/comments" && request.method === "POST") {
      const s = await requireUser(request, env);
      const tierInfo = await getActiveTier(env, s.user.id);
      if (tierInfo.tier === "free") {
        return err("برای نوشتن نظر اشتراک Gold یا Diamond لازم است", 403, origin);
      }
      const body = await request.json().catch(() => ({}));
      const songId = body.songId;
      const text = String(body.body || "").trim();
      if (!songId || text.length < 1 || text.length > 1000) {
        return err("متن نظر معتبر نیست", 400, origin);
      }
      const id = uid();
      await env.DB.prepare(
        `INSERT INTO comments(id, song_id, user_id, body, created_at) VALUES(?,?,?,?,?)`
      )
        .bind(id, songId, s.user.id, text, now())
        .run();
      return json({ id, ok: true }, 201, { origin });
    }

    if (path === "/api/comments/like" && request.method === "POST") {
      const s = await requireUser(request, env);
      const body = await request.json().catch(() => ({}));
      const commentId = body.commentId;
      if (!commentId) return err("commentId required", 400, origin);
      const already = await env.DB.prepare(
        `SELECT 1 FROM comment_likes WHERE user_id = ? AND comment_id = ?`
      )
        .bind(s.user.id, commentId)
        .first();
      if (already) {
        await env.DB.prepare(`DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?`)
          .bind(s.user.id, commentId)
          .run();
        return json({ liked: false }, 200, { origin });
      }
      await env.DB.prepare(
        `INSERT INTO comment_likes(user_id, comment_id, created_at) VALUES(?,?,?)`
      )
        .bind(s.user.id, commentId, now())
        .run();
      await awardXP(env, s.user.id, "like_comment_" + commentId, 3);
      return json({ liked: true }, 200, { origin });
    }

    if (path === "/api/submissions" && request.method === "GET") {
      const s = await requireUser(request, env);
      const rows = await env.DB.prepare(
        `SELECT id, title, artist, genre, status, submitted_at, reject_reason, storage_bytes
         FROM submissions WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 50`
      )
        .bind(s.user.id)
        .all();
      const submissions = (rows.results || []).map((x) => ({
        ...x,
        submitted_at: x.submitted_at ? x.submitted_at * 1000 : null,
      }));
      const quota = await buildQuota(env, s.user.id);
      return json({ submissions, quota }, 200, { origin });
    }

    if (path === "/api/submissions" && request.method === "POST") {
      const s = await requireUser(request, env);
      const tierInfo = await getActiveTier(env, s.user.id);
      const maxUploads = dailyUploadCap(tierInfo.tier);
      const dayStart = now() - 86400;
      const countRow = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND submitted_at > ?`
      )
        .bind(s.user.id, dayStart)
        .first();
      if ((countRow?.c || 0) >= maxUploads) {
        return err(`سقف ارسال روزانه (${maxUploads}) پر شده است`, 429, origin);
      }

      const form = await request.formData();
      const title = String(form.get("title") || "").trim();
      const artist = String(form.get("artist") || "").trim();
      const genre = String(form.get("genre") || "سایر").trim();
      const description = String(form.get("description") || "").trim();
      const audio = form.get("audio");
      const cover = form.get("cover");

      if (!title || !artist || !audio || typeof audio === "string") {
        return err("عنوان، هنرمند و فایل صوتی الزامی است", 400, origin);
      }
      const maxBytes = 20 * 1024 * 1024;
      if (audio.size > maxBytes) return err("حجم فایل بیش از ۲۰ مگابایت است", 413, origin);

      const quotaMb = Number(env.USER_UPLOAD_QUOTA_MB || 100);
      const usedRow = await env.DB.prepare(
        `SELECT COALESCE(SUM(storage_bytes),0) as used FROM submissions WHERE user_id = ? AND status != 'rejected'`
      )
        .bind(s.user.id)
        .first();
      const used = bytes(usedRow?.used);
      if (used + audio.size > quotaMb * 1024 * 1024) {
        return err("سهمیه فضای ذخیره‌سازی شما پر شده", 413, origin);
      }

      const id = uid();
      const audioKey = `submissions/${s.user.id}/${id}/audio`;
      let coverKey = null;
      await env.AUDIO.put(audioKey, audio.stream(), {
        httpMetadata: { contentType: audio.type || "audio/mpeg" },
      });
      if (cover && typeof cover !== "string" && cover.size > 0) {
        coverKey = `submissions/${s.user.id}/${id}/cover`;
        await env.AUDIO.put(coverKey, cover.stream(), {
          httpMetadata: { contentType: cover.type || "image/jpeg" },
        });
      }

      await env.DB.prepare(
        `INSERT INTO submissions(id, user_id, title, artist, genre, description, audio_key, cover_key, mime_type, storage_bytes, status, submitted_at)
         VALUES(?,?,?,?,?,?,?,?,?,?, 'pending', ?)`
      )
        .bind(
          id,
          s.user.id,
          title,
          artist,
          genre,
          description,
          audioKey,
          coverKey,
          audio.type || "audio/mpeg",
          audio.size,
          now()
        )
        .run();

      await env.DB.prepare(
        `INSERT INTO storage_registry(id, owner_id, provider, object_key, media_type, byte_size, status, created_at, updated_at)
         VALUES(?,?,?,?,?,?, 'active', ?, ?)`
      )
        .bind(uid(), s.user.id, "r2", audioKey, audio.type || "audio/mpeg", audio.size, now(), now())
        .run();

      const quota = await buildQuota(env, s.user.id);
      return json({ id, status: "pending", quota }, 201, { origin });
    }

    if (path === "/api/quota" && request.method === "GET") {
      const s = await requireUser(request, env);
      return json(await buildQuota(env, s.user.id), 200, { origin });
    }

    if (path === "/api/admin/submissions" && request.method === "GET") {
      await requireAdmin(request, env);
      const status = url.searchParams.get("status") || "pending";
      const rows = await env.DB.prepare(
        `SELECT sub.*, u.name as user_name, u.email as user_email
         FROM submissions sub JOIN users u ON u.id = sub.user_id
         WHERE sub.status = ? ORDER BY sub.submitted_at ASC LIMIT 100`
      )
        .bind(status)
        .all();
      const submissions = (rows.results || []).map((x) => ({
        ...x,
        submitted_at: x.submitted_at ? x.submitted_at * 1000 : null,
        reviewed_at: x.reviewed_at ? x.reviewed_at * 1000 : null,
      }));
      return json({ submissions }, 200, { origin });
    }

    const adminReview = path.match(/^\/api\/admin\/submissions\/([^/]+)\/(approve|reject)$/);
    if (adminReview && request.method === "POST") {
      await requireAdmin(request, env);
      const id = decodeURIComponent(adminReview[1]);
      const action = adminReview[2];
      const body = await request.json().catch(() => ({}));
      const reason = String(body.reason || "").trim();

      const sub = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?`).bind(id).first();
      if (!sub) return err("یافت نشد", 404, origin);
      if (sub.status !== "pending") return err("این ارسال قبلاً بررسی شده", 400, origin);

      if (action === "reject") {
        await env.DB.prepare(
          `UPDATE submissions SET status = 'rejected', reviewed_at = ?, reject_reason = ? WHERE id = ?`
        )
          .bind(now(), reason || "رد شده توسط مدیر", id)
          .run();
        return json({ ok: true, status: "rejected" }, 200, { origin });
      }

      const songId = uid();
      await env.DB.prepare(
        `INSERT INTO songs(id, title, artist, genre, description, audio_key, cover_key, mime_type, uploaded_by, published, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,1,?)`
      )
        .bind(
          songId,
          sub.title,
          sub.artist,
          sub.genre,
          sub.description,
          sub.audio_key,
          sub.cover_key,
          sub.mime_type,
          sub.user_id,
          now()
        )
        .run();
      await env.DB.prepare(
        `UPDATE submissions SET status = 'approved', reviewed_at = ? WHERE id = ?`
      )
        .bind(now(), id)
        .run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO song_stats(song_id, play_count, updated_at) VALUES(?,0,?)`
      )
        .bind(songId, now())
        .run();
      return json({ ok: true, status: "approved", songId }, 200, { origin });
    }

    if (path.startsWith("/api/admin/submissions/") && request.method === "POST") {
      await requireAdmin(request, env);
      const id = decodeURIComponent(path.slice("/api/admin/submissions/".length));
      if (id.includes("/")) return err("مسیر نامعتبر", 404, origin);
      const body = await request.json().catch(() => ({}));
      const action = body.action;
      const reason = String(body.reason || "").trim();
      const sub = await env.DB.prepare(`SELECT * FROM submissions WHERE id = ?`).bind(id).first();
      if (!sub) return err("یافت نشد", 404, origin);
      if (sub.status !== "pending") return err("این ارسال قبلاً بررسی شده", 400, origin);

      if (action === "reject") {
        await env.DB.prepare(
          `UPDATE submissions SET status = 'rejected', reviewed_at = ?, reject_reason = ? WHERE id = ?`
        )
          .bind(now(), reason || "رد شده توسط مدیر", id)
          .run();
        return json({ ok: true, status: "rejected" }, 200, { origin });
      }
      if (action === "approve") {
        const songId = uid();
        await env.DB.prepare(
          `INSERT INTO songs(id, title, artist, genre, description, audio_key, cover_key, mime_type, uploaded_by, published, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,1,?)`
        )
          .bind(
            songId,
            sub.title,
            sub.artist,
            sub.genre,
            sub.description,
            sub.audio_key,
            sub.cover_key,
            sub.mime_type,
            sub.user_id,
            now()
          )
          .run();
        await env.DB.prepare(
          `UPDATE submissions SET status = 'approved', reviewed_at = ? WHERE id = ?`
        )
          .bind(now(), id)
          .run();
        await env.DB.prepare(
          `INSERT OR IGNORE INTO song_stats(song_id, play_count, updated_at) VALUES(?,0,?)`
        )
          .bind(songId, now())
          .run();
        return json({ ok: true, status: "approved", songId }, 200, { origin });
      }
      return err("action باید approve یا reject باشد", 400, origin);
    }

    if (path === "/api/admin/songs" && request.method === "POST") {
      const s = await requireAdmin(request, env);
      const form = await request.formData();
      const title = String(form.get("title") || "").trim();
      const artist = String(form.get("artist") || "").trim();
      const genre = String(form.get("genre") || "سایر").trim();
      const description = String(form.get("description") || "").trim();
      const audio = form.get("audio");
      const cover = form.get("cover");
      if (!title || !artist || !audio || typeof audio === "string") {
        return err("فیلدهای الزامی ناقص است", 400, origin);
      }
      const id = uid();
      const audioKey = `songs/${id}/audio`;
      let coverKey = null;
      await env.AUDIO.put(audioKey, audio.stream(), {
        httpMetadata: { contentType: audio.type || "audio/mpeg" },
      });
      if (cover && typeof cover !== "string" && cover.size > 0) {
        coverKey = `songs/${id}/cover`;
        await env.AUDIO.put(coverKey, cover.stream(), {
          httpMetadata: { contentType: cover.type || "image/jpeg" },
        });
      }
      await env.DB.prepare(
        `INSERT INTO songs(id, title, artist, genre, description, audio_key, cover_key, mime_type, uploaded_by, published, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,1,?)`
      )
        .bind(
          id,
          title,
          artist,
          genre,
          description,
          audioKey,
          coverKey,
          audio.type || "audio/mpeg",
          s.user.id,
          now()
        )
        .run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO song_stats(song_id, play_count, updated_at) VALUES(?,0,?)`
      )
        .bind(id, now())
        .run();
      return json({ id, ok: true }, 201, { origin });
    }

    if (path.startsWith("/api/submission-preview/") && request.method === "GET") {
      await requireAdmin(request, env);
      const id = decodeURIComponent(path.slice("/api/submission-preview/".length));
      const sub = await env.DB.prepare(`SELECT audio_key, mime_type FROM submissions WHERE id = ?`)
        .bind(id)
        .first();
      if (!sub) return err("یافت نشد", 404, origin);
      const obj = await env.AUDIO.get(sub.audio_key);
      if (!obj) return err("فایل موجود نیست", 404, origin);
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("content-type", sub.mime_type || "audio/mpeg");
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => headers.set(k, v));
      return new Response(obj.body, { status: 200, headers });
    }

    if (path === "/api/admin/subscription" && request.method === "POST") {
      await requireAdmin(request, env);
      const body = await request.json().catch(() => ({}));
      const userId = body.userId;
      const tier = body.tier;
      const days = Number(body.days) || 30;
      if (!userId || !["free", "gold", "diamond"].includes(tier)) {
        return err("userId و tier معتبر لازم است", 400, origin);
      }
      const t = now();
      const expires = tier === "free" ? null : t + days * 86400;
      await env.DB.prepare(
        `UPDATE subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active'`
      )
        .bind(userId)
        .run();
      await env.DB.prepare(
        `INSERT INTO subscriptions(id, user_id, tier, status, starts_at, expires_at, source, created_at)
         VALUES(?,?,?,?,?,?,?,?)`
      )
        .bind(uid(), userId, tier, "active", t, expires, "admin", t)
        .run();
      return json({ ok: true, tier, expiresAt: expires ? expires * 1000 : null }, 200, { origin });
    }

    if (path === "/api/tickets" && request.method === "GET") {
      const s = await requireUser(request, env);
      const rows = await env.DB.prepare(
        `SELECT id, subject, body, status, reply, created_at FROM tickets WHERE user_id = ? ORDER BY created_at DESC`
      )
        .bind(s.user.id)
        .all();
      const tickets = (rows.results || []).map((t) => ({
        ...t,
        created_at: t.created_at ? t.created_at * 1000 : null,
      }));
      return json({ tickets }, 200, { origin });
    }

    if (path === "/api/tickets" && request.method === "POST") {
      const s = await requireUser(request, env);
      const body = await request.json().catch(() => ({}));
      const subject = String(body.subject || "").trim();
      const text = String(body.body || "").trim();
      if (!subject || !text) return err("موضوع و متن الزامی است", 400, origin);
      const id = uid();
      await env.DB.prepare(
        `INSERT INTO tickets(id, user_id, subject, body, status, created_at) VALUES(?,?,?,?, 'open', ?)`
      )
        .bind(id, s.user.id, subject, text, now())
        .run();
      return json({ id, ok: true }, 201, { origin });
    }

    if (path === "/api/rooms" && request.method === "POST") {
      await getSession(request, env);
      const body = await request.json().catch(() => ({}));
      const code = "DV-" + token().slice(0, 6).toUpperCase();
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      await stub.fetch(new Request("https://room/internal", { method: "GET" }));
      return json({ code, songId: body.songId || null }, 201, { origin });
    }

    if (path.startsWith("/api/rooms/") && path.endsWith("/connect")) {
      const code = decodeURIComponent(path.slice("/api/rooms/".length, -"/connect".length));
      if (!code) return err("کد اتاق نامعتبر", 400, origin);
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    if (path === "/api/explore/trending" && request.method === "GET") {
      const sort = url.searchParams.get("sort") || "popular";
      let rows;
      if (sort === "popular") {
        rows = await env.DB.prepare(
          `SELECT so.id, so.title, so.artist, so.genre, so.cover_key, so.mime_type, so.created_at, so.published,
                  COALESCE(ss.play_count, 0) as play_count
           FROM songs so LEFT JOIN song_stats ss ON ss.song_id = so.id
           WHERE so.published = 1
           ORDER BY play_count DESC, so.created_at DESC LIMIT 50`
        ).all();
      } else {
        rows = await env.DB.prepare(
          `SELECT id, title, artist, genre, cover_key, mime_type, created_at, published
           FROM songs WHERE published = 1 ORDER BY created_at DESC LIMIT 50`
        ).all();
      }
      return json(
        { songs: (rows.results || []).map((r) => publicSong(r, request.url)) },
        200,
        { origin }
      );
    }

    if (path === "/api/subscription" && request.method === "GET") {
      const s = await requireUser(request, env);
      const info = await getActiveTier(env, s.user.id);
      return json(
        {
          tier: info.tier,
          active: info.active,
          expiresAt: info.expiresAt ? info.expiresAt * 1000 : null,
          playlistCap: playlistCap(info.tier),
        },
        200,
        { origin }
      );
    }

    if (path === "/api/level" && request.method === "GET") {
      const s = await requireUser(request, env);
      const sum = await env.DB.prepare(
        `SELECT COALESCE(SUM(xp),0) as total FROM xp_events WHERE user_id = ?`
      )
        .bind(s.user.id)
        .first();
      return json(levelFromXP(Number(sum?.total || 0)), 200, { origin });
    }

    if (path === "/api/playlists" && request.method === "GET") {
      const s = await requireUser(request, env);
      const tierInfo = await getActiveTier(env, s.user.id);
      const rows = await env.DB.prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id) as song_count
         FROM playlists p WHERE p.user_id = ? ORDER BY p.created_at DESC`
      )
        .bind(s.user.id)
        .all();
      return json({ playlists: rows.results || [], tier: tierInfo.tier }, 200, { origin });
    }

    if (path === "/api/playlists" && request.method === "POST") {
      const s = await requireUser(request, env);
      const tierInfo = await getActiveTier(env, s.user.id);
      const cap = playlistCap(tierInfo.tier);
      const countRow = await env.DB.prepare(`SELECT COUNT(*) as c FROM playlists WHERE user_id = ?`)
        .bind(s.user.id)
        .first();
      if ((countRow?.c || 0) >= cap) {
        return err(`سقف پلی‌لیست برای اشتراک شما ${cap} است`, 403, origin);
      }
      const body = await request.json().catch(() => ({}));
      const name = String(body.name || "").trim();
      const description = String(body.description || "").trim();
      const visibility = body.visibility === "public" ? "public" : "private";
      if (name.length < 2) return err("نام پلی‌لیست کوتاه است", 400, origin);
      const id = uid();
      const t = now();
      await env.DB.prepare(
        `INSERT INTO playlists(id, user_id, name, description, visibility, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?)`
      )
        .bind(id, s.user.id, name, description, visibility, t, t)
        .run();
      await awardXP(env, s.user.id, "playlist_" + id, 20);
      return json({ id, ok: true }, 201, { origin });
    }

    if (path.match(/^\/api\/playlists\/[^/]+$/) && request.method === "GET") {
      const id = decodeURIComponent(path.slice("/api/playlists/".length));
      const pl = await env.DB.prepare(
        `SELECT p.*, u.name as owner_name FROM playlists p JOIN users u ON u.id = p.user_id WHERE p.id = ?`
      )
        .bind(id)
        .first();
      if (!pl) return err("پلی‌لیست پیدا نشد", 404, origin);
      const s = await getSession(request, env);
      if (pl.visibility === "private" && (!s || s.user.id !== pl.user_id)) {
        return err("این پلی‌لیست خصوصی است", 403, origin);
      }
      const songs = await env.DB.prepare(
        `SELECT so.id, so.title, so.artist, so.genre, so.cover_key, so.mime_type, so.created_at, so.published, ps.position
         FROM playlist_songs ps JOIN songs so ON so.id = ps.song_id
         WHERE ps.playlist_id = ? ORDER BY ps.position ASC, ps.added_at ASC`
      )
        .bind(id)
        .all();
      return json(
        {
          playlist: pl,
          songs: (songs.results || []).map((r) => publicSong(r, request.url)),
        },
        200,
        { origin }
      );
    }

    if (path.match(/^\/api\/playlists\/[^/]+\/songs$/) && request.method === "POST") {
      const s = await requireUser(request, env);
      const playlistId = decodeURIComponent(path.slice("/api/playlists/".length, -"/songs".length));
      const pl = await env.DB.prepare(`SELECT * FROM playlists WHERE id = ? AND user_id = ?`)
        .bind(playlistId, s.user.id)
        .first();
      if (!pl) return err("پلی‌لیست پیدا نشد", 404, origin);
      const body = await request.json().catch(() => ({}));
      const songId = body.songId;
      if (!songId) return err("songId required", 400, origin);
      const song = await env.DB.prepare(`SELECT id FROM songs WHERE id = ? AND published = 1`)
        .bind(songId)
        .first();
      if (!song) return err("آهنگ معتبر نیست", 404, origin);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO playlist_songs(playlist_id, song_id, position, added_at) VALUES(?,?,0,?)`
      )
        .bind(playlistId, songId, now())
        .run();
      await env.DB.prepare(`UPDATE playlists SET updated_at = ? WHERE id = ?`)
        .bind(now(), playlistId)
        .run();
      return json({ ok: true }, 200, { origin });
    }

    if (path === "/api/profile/settings" && request.method === "POST") {
      const s = await requireUser(request, env);
      const body = await request.json().catch(() => ({}));
      const visibility = body.visibility === "private" ? "private" : "public";
      await ensureUserProfile(env, s.user.id);
      await env.DB.prepare(
        `UPDATE user_profiles SET visibility = ?, updated_at = ? WHERE user_id = ?`
      )
        .bind(visibility, now(), s.user.id)
        .run();
      return json({ ok: true, visibility }, 200, { origin });
    }

    if (path === "/api/social/search" && request.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 1) return json({ users: [] }, 200, { origin });
      const rows = await env.DB.prepare(
        `SELECT u.id, u.name,
                COALESCE((
                  SELECT tier FROM subscriptions sub
                  WHERE sub.user_id = u.id AND sub.status = 'active'
                  ORDER BY CASE tier WHEN 'diamond' THEN 3 WHEN 'gold' THEN 2 ELSE 1 END DESC
                  LIMIT 1
                ), 'free') as tier
         FROM users u
         JOIN user_profiles p ON p.user_id = u.id
         WHERE p.visibility = 'public' AND (u.name LIKE ? OR u.email LIKE ?)
         LIMIT 30`
      )
        .bind("%" + q + "%", "%" + q + "%")
        .all();
      return json({ users: rows.results || [] }, 200, { origin });
    }

    if (path.startsWith("/api/social/profile/") && request.method === "GET") {
      const targetId = decodeURIComponent(path.slice("/api/social/profile/".length));
      const profile = await env.DB.prepare(
        `SELECT u.id, u.name, p.bio, p.visibility, p.avatar_key
         FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id
         WHERE u.id = ?`
      )
        .bind(targetId)
        .first();
      if (!profile) return err("کاربر پیدا نشد", 404, origin);

      const s = await getSession(request, env);
      if (profile.visibility === "private" && (!s || s.user.id !== targetId)) {
        return json(
          {
            profile: { id: profile.id, name: profile.name, bio: "", visibility: "private" },
            followers: 0,
            following: 0,
            followState: null,
            pins: [],
            playlists: [],
          },
          200,
          { origin }
        );
      }

      const followers = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM follows WHERE followed_id = ? AND status = 'accepted'`
      )
        .bind(targetId)
        .first();
      const following = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM follows WHERE follower_id = ? AND status = 'accepted'`
      )
        .bind(targetId)
        .first();

      let followState = null;
      if (s && s.user.id !== targetId) {
        const f = await env.DB.prepare(
          `SELECT status FROM follows WHERE follower_id = ? AND followed_id = ?`
        )
          .bind(s.user.id, targetId)
          .first();
        followState = f ? f.status : null;
      }

      const pins = await env.DB.prepare(
        `SELECT so.id, so.title, so.artist, so.genre, so.cover_key, so.mime_type, so.created_at, so.published
         FROM profile_pins pp JOIN songs so ON so.id = pp.song_id
         WHERE pp.user_id = ? ORDER BY pp.position ASC LIMIT 20`
      )
        .bind(targetId)
        .all();

      const playlists = await env.DB.prepare(
        `SELECT p.id, p.name,
                (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id) as song_count
         FROM playlists p WHERE p.user_id = ? AND p.visibility = 'public'
         ORDER BY p.updated_at DESC LIMIT 20`
      )
        .bind(targetId)
        .all();

      return json(
        {
          profile,
          followers: followers?.c || 0,
          following: following?.c || 0,
          followState,
          pins: (pins.results || []).map((r) => publicSong(r, request.url)),
          playlists: playlists.results || [],
        },
        200,
        { origin }
      );
    }

    if (path.startsWith("/api/social/follow/") && request.method === "POST") {
      const s = await requireUser(request, env);
      const targetId = decodeURIComponent(path.slice("/api/social/follow/".length));
      if (targetId === s.user.id) return err("نمی‌توانید خودتان را دنبال کنید", 400, origin);
      const target = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(targetId).first();
      if (!target) return err("کاربر پیدا نشد", 404, origin);

      const existing = await env.DB.prepare(
        `SELECT status FROM follows WHERE follower_id = ? AND followed_id = ?`
      )
        .bind(s.user.id, targetId)
        .first();
      if (existing) return json({ state: existing.status }, 200, { origin });

      const prof = await env.DB.prepare(`SELECT visibility FROM user_profiles WHERE user_id = ?`)
        .bind(targetId)
        .first();
      const status = prof && prof.visibility === "private" ? "pending" : "accepted";
      const t = now();
      await env.DB.prepare(
        `INSERT INTO follows(follower_id, followed_id, status, created_at, updated_at) VALUES(?,?,?,?,?)`
      )
        .bind(s.user.id, targetId, status, t, t)
        .run();

      try {
        await env.DB.prepare(
          `INSERT INTO notifications(id, user_id, actor_id, kind, reference_id, body, created_at)
           VALUES(?,?,?,?,?,?,?)`
        )
          .bind(
            uid(),
            targetId,
            s.user.id,
            status === "pending" ? "follow_request" : "follow",
            s.user.id,
            status === "pending" ? "درخواست دنبال‌کردن" : "شما را دنبال کرد",
            t
          )
          .run();
      } catch {}

      return json({ state: status }, 200, { origin });
    }

    if (path === "/api/social/follow-requests" && request.method === "GET") {
      const s = await requireUser(request, env);
      const rows = await env.DB.prepare(
        `SELECT f.follower_id, u.name, f.created_at
         FROM follows f JOIN users u ON u.id = f.follower_id
         WHERE f.followed_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC`
      )
        .bind(s.user.id)
        .all();
      return json({ requests: rows.results || [] }, 200, { origin });
    }

    if (path.match(/^\/api\/social\/follow-requests\/[^/]+\/accept$/) && request.method === "POST") {
      const s = await requireUser(request, env);
      const followerId = decodeURIComponent(
        path.slice("/api/social/follow-requests/".length, -"/accept".length)
      );
      await env.DB.prepare(
        `UPDATE follows SET status = 'accepted', updated_at = ?
         WHERE follower_id = ? AND followed_id = ? AND status = 'pending'`
      )
        .bind(now(), followerId, s.user.id)
        .run();
      return json({ ok: true }, 200, { origin });
    }

    if (path === "/api/social/stats" && request.method === "GET") {
      const s = await requireUser(request, env);
      const followers = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM follows WHERE followed_id = ? AND status = 'accepted'`
      )
        .bind(s.user.id)
        .first();
      const following = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM follows WHERE follower_id = ? AND status = 'accepted'`
      )
        .bind(s.user.id)
        .first();
      return json(
        { followers: followers?.c || 0, following: following?.c || 0 },
        200,
        { origin }
      );
    }

    if (path === "/api/social/pin" && request.method === "POST") {
      const s = await requireUser(request, env);
      const body = await request.json().catch(() => ({}));
      const songId = body.songId;
      if (!songId) return err("songId required", 400, origin);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO profile_pins(user_id, song_id, position, created_at) VALUES(?,?,0,?)`
      )
        .bind(s.user.id, songId, now())
        .run();
      return json({ ok: true }, 200, { origin });
    }

    if (path === "/api/stories" && request.method === "GET") {
      const s = await requireUser(request, env);
      const rows = await env.DB.prepare(
        `SELECT st.id, st.text, st.created_at, st.expires_at,
                u.id as user_id, u.name as user_name,
                so.id as song_id, so.title as song_title, so.artist as song_artist
         FROM stories st
         JOIN users u ON u.id = st.user_id
         JOIN songs so ON so.id = st.song_id
         WHERE st.expires_at > ?
           AND (st.user_id = ? OR st.user_id IN (
             SELECT followed_id FROM follows WHERE follower_id = ? AND status = 'accepted'
           ))
         ORDER BY st.created_at DESC LIMIT 50`
      )
        .bind(now(), s.user.id, s.user.id)
        .all();
      const stories = (rows.results || []).map((st) => ({
        ...st,
        created_at: st.created_at ? st.created_at * 1000 : null,
        expires_at: st.expires_at ? st.expires_at * 1000 : null,
      }));
      return json({ stories }, 200, { origin });
    }

    if (path === "/api/stories" && request.method === "POST") {
      const s = await requireUser(request, env);
      const body = await request.json().catch(() => ({}));
      const songId = body.songId;
      const text = String(body.text || "").trim().slice(0, 280);
      if (!songId) return err("آهنگ انتخاب نشده", 400, origin);
      const song = await env.DB.prepare(`SELECT id FROM songs WHERE id = ? AND published = 1`)
        .bind(songId)
        .first();
      if (!song) return err("آهنگ معتبر نیست", 404, origin);
      const id = uid();
      const t = now();
      const expires = t + 24 * 3600;
      await env.DB.prepare(
        `INSERT INTO stories(id, user_id, song_id, text, created_at, expires_at) VALUES(?,?,?,?,?,?)`
      )
        .bind(id, s.user.id, songId, text, t, expires)
        .run();
      return json({ id, expiresAt: expires * 1000 }, 201, { origin });
    }

    if (path.match(/^\/api\/stories\/[^/]+\/react$/) && request.method === "POST") {
      const s = await requireUser(request, env);
      const storyId = decodeURIComponent(path.slice("/api/stories/".length, -"/react".length));
      await env.DB.prepare(
        `INSERT OR IGNORE INTO story_reactions(user_id, story_id, created_at) VALUES(?,?,?)`
      )
        .bind(s.user.id, storyId, now())
        .run();
      return json({ ok: true }, 200, { origin });
    }

    return err("مسیر پیدا نشد", 404, origin);
  } catch (e) {
    if (e && e.status) return err(e.message || "خطا", e.status, origin);
    console.error("Worker error", e);
    return err("خطای داخلی سرور", 500, origin);
  }
}
