PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 salt TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS songs(
 id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, genre TEXT NOT NULL,
 description TEXT, audio_key TEXT NOT NULL, cover_key TEXT, mime_type TEXT,
 uploaded_by TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS songs_published_created ON songs(published,created_at);

CREATE TABLE IF NOT EXISTS submissions(
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL, artist TEXT NOT NULL, genre TEXT NOT NULL,
 description TEXT, audio_key TEXT, cover_key TEXT, mime_type TEXT,
 storage_bytes INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 submitted_at INTEGER NOT NULL, reviewed_at INTEGER, reject_reason TEXT,
 UNIQUE(id)
);
CREATE INDEX IF NOT EXISTS submissions_user_time ON submissions(user_id,submitted_at);
CREATE INDEX IF NOT EXISTS submissions_status_time ON submissions(status,submitted_at);

CREATE TABLE IF NOT EXISTS favorites(
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,song_id)
);
CREATE TABLE IF NOT EXISTS comments(
 id TEXT PRIMARY KEY, song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets(
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, reply TEXT, created_at INTEGER NOT NULL
);


-- Dark Valley V4 social, playlist, subscription, stories and progression modules
CREATE TABLE IF NOT EXISTS user_profiles(
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 bio TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','private')),
 avatar_key TEXT, frame_key TEXT, wallpaper_app TEXT, wallpaper_home TEXT, wallpaper_player TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions(
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 tier TEXT NOT NULL CHECK(tier IN ('free','gold','diamond')), status TEXT NOT NULL DEFAULT 'active',
 starts_at INTEGER NOT NULL, expires_at INTEGER, source TEXT NOT NULL DEFAULT 'admin', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_user_active ON subscriptions(user_id,status,expires_at);
CREATE TABLE IF NOT EXISTS playlists(
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('public','private')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS playlists_user_created ON playlists(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS playlist_songs(
 playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
 song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
 position INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL,
 PRIMARY KEY(playlist_id,song_id)
);
CREATE TABLE IF NOT EXISTS follows(
 follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 followed_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(follower_id,followed_id), CHECK(follower_id<>followed_id)
);
CREATE INDEX IF NOT EXISTS follows_followed_status ON follows(followed_id,status);
CREATE TABLE IF NOT EXISTS song_likes(
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, PRIMARY KEY(user_id,song_id)
);
CREATE TABLE IF NOT EXISTS comment_likes(
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, PRIMARY KEY(user_id,comment_id)
);
CREATE TABLE IF NOT EXISTS profile_pins(
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
 position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,song_id)
);
CREATE TABLE IF NOT EXISTS stories(
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
 text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stories_expiry ON stories(expires_at DESC);
CREATE TABLE IF NOT EXISTS story_reactions(
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, PRIMARY KEY(user_id,story_id)
);
CREATE TABLE IF NOT EXISTS notifications(
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 kind TEXT NOT NULL, reference_id TEXT, body TEXT NOT NULL DEFAULT '', is_read INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user_time ON notifications(user_id,is_read,created_at DESC);
CREATE TABLE IF NOT EXISTS user_blocks(
 blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, PRIMARY KEY(blocker_id,blocked_id), CHECK(blocker_id<>blocked_id)
);
CREATE TABLE IF NOT EXISTS reports(
 id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 target_type TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS xp_events(
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_key TEXT NOT NULL, xp INTEGER NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(user_id,event_key)
);
CREATE INDEX IF NOT EXISTS xp_user_time ON xp_events(user_id,created_at);
CREATE TABLE IF NOT EXISTS user_wallets(
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 points INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owned_items(
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL, source TEXT NOT NULL, acquired_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,item_id)
);
CREATE TABLE IF NOT EXISTS storage_registry(
 id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 provider TEXT NOT NULL, object_key TEXT NOT NULL, media_type TEXT NOT NULL,
 byte_size INTEGER NOT NULL, checksum TEXT, status TEXT NOT NULL DEFAULT 'active',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(provider,object_key)
);


-- Backfill V4 metadata for accounts that existed before the upgrade.
INSERT OR IGNORE INTO user_profiles(user_id,created_at,updated_at) SELECT id,created_at,created_at FROM users;
INSERT OR IGNORE INTO subscriptions(id,user_id,tier,status,starts_at,expires_at,source,created_at) SELECT lower(hex(randomblob(16))),id,'free','active',created_at,NULL,'migration',created_at FROM users;
INSERT OR IGNORE INTO user_wallets(user_id,points,updated_at) SELECT id,0,created_at FROM users;

CREATE TABLE IF NOT EXISTS song_stats(
 song_id TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
 play_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
