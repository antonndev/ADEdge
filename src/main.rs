// main.rs — ADEdge (axum) server stabil și low-footprint
//
// ✔ rute & comportamente ca în varianta Node
// ✔ HTTP simplu + TLS nativ opțional (axum-server) dacă ai SSL_* în .env
// ✔ .env bootstrap (creează cheile lipsă fără a strica ce ai)
// ✔ users.json / images.json / settings.json (persistență)
// ✔ autentificare cu cookie HMAC (username.ts.hmac), 30 zile, httpOnly
// ✔ upload RAW (ShareX) + upload multipart (dashboard)
// ✔ ratelimit per-IP (token bucket)
// ✔ pagini statice din ./public
// ✔ /i/:filename și /i/:filename/view (OG)
// ✔ /api/generate-sxcu (Binary)
// ✔ /api/account/*, /api/images/*, admin, register public
//
// -------------------
// Cargo.toml minim (asigură-te că ai dep-urile astea):
//
// [dependencies]
// axum = { version = "0.7", features = ["macros", "multipart"] }
// tokio = { version = "1", features = ["full"] }
// tower = "0.4"
// tower-http = { version = "0.5", features = ["fs", "compression-gzip", "compression-br", "trace"] }
// serde = { version = "1", features = ["derive"] }
// serde_json = "1"
// uuid = { version = "1", features = ["v4", "serde"] }
// bcrypt = "0.15"
// dotenvy = "0.15"
// rand = "0.8"
// hmac = "0.12"
// sha2 = "0.10"
// hex = "0.4"
// mime_guess = "2"
// parking_lot = "0.12"
// hyper = { version = "1", features = ["http1", "server"] }
// http = "1"
// tokio-util = { version = "0.7", features = ["io"] }
// chrono = { version = "0.4", default-features = false, features = ["clock"] }
// urlencoding = "2"
// tokio-stream = "0.1"
//
// # pentru TLS nativ
// axum-server = { version = "0.6", features = ["tls-rustls"] }
//
// Build & run:
//   cargo run --release
//

use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use axum_server::tls_rustls::RustlsConfig;
use axum::{response::Redirect, extract::{Host, OriginalUri}};

use std::{
    collections::HashMap,
    fs,
    io::{self, Write},
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{fs as tfs, io::AsyncWriteExt, signal};
use tokio_util::io::ReaderStream;
use tokio_stream::StreamExt; // pentru .next() pe BodyDataStream
use tower_http::services::ServeDir;
use tokio::io::{AsyncReadExt, AsyncSeekExt}; // pentru .take() și .seek()
use std::io::SeekFrom;                       // pentru SeekFrom::Start(...)
use uuid::Uuid;

// ========================= Constante & Defaults =========================
const DEFAULT_PORT: u16 = 3000;
const DEFAULT_PORT_HTTPS: u16 = 443;
const DEFAULT_UPLOAD_DIR: &str = "uploads";
const DEFAULT_MAX_UPLOAD_BYTES: u64 = 10 * 1024 * 1024;
const DEFAULT_RATE_TOKENS: f32 = 20.0;
const DEFAULT_RATE_REFILL: f32 = 1.0; // tokens/sec
const SESSION_MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000; // 30 zile
const DEFAULT_BG_COLOR: &str = "#05080f";

// ========================= Tipuri persistente =========================
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackgroundPref {
    #[serde(rename = "type")]
    kind: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Preferences {
    background: BackgroundPref,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct User {
    username: String,
    password_hash: String,
    email: String,
    created_at: u64,
    role: String,
    preferences: Preferences,
    images: Vec<ImageMeta>,
}
impl Default for User {
    fn default() -> Self {
        Self {
            username: String::new(),
            password_hash: String::new(),
            email: String::new(),
            created_at: now_ms(),
            role: "user".into(),
            preferences: Preferences {
                background: BackgroundPref {
                    kind: "color".into(),
                    value: DEFAULT_BG_COLOR.into(),
                },
            },
            images: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImageMeta {
    id: String,
    filename: String,
    originalname: String,
    size: u64,
    url: String,
    uploaded_at: u64,
    owner: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct UsersJson {
    users: Vec<User>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ImagesJson {
    images: Vec<ImageMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SettingsJson {
    registerBlocked: bool,
}
impl Default for SettingsJson {
    fn default() -> Self {
        Self {
            registerBlocked: false,
        }
    }
}

// ========================= Config + stare =========================
#[derive(Debug, Clone)]
struct Config {
    http_port: u16,
    https_port: u16,
    upload_dir: PathBuf,
    background_dir: PathBuf,
    public_dir: PathBuf,
    dashboard_html: PathBuf,
    data_dir: PathBuf,
    users_file: PathBuf,
    images_file: PathBuf,
    settings_file: PathBuf,
    max_upload_bytes: u64,
    rate_tokens: f32,
    rate_refill: f32,
    ssl_key_path: Option<PathBuf>,
    ssl_cert_path: Option<PathBuf>,
}

#[derive(Default)]
struct RateBucket {
    tokens: f32,
    last: f64,
}

#[derive(Clone)]
struct AppState {
    cfg: Arc<Config>,
    session_secret: Arc<String>,
    upload_token_hash: Arc<Mutex<String>>, // bcrypt hash
    // one-time plain token acceptable at boot
    initial_upload_token_plain: Arc<Mutex<Option<String>>>,
    // first-run admin password (optional)
    initial_admin_pass_plain: Arc<Mutex<Option<String>>>,
    users: Arc<Mutex<UsersJson>>,   // în memorie + persist pe disc
    images: Arc<Mutex<ImagesJson>>, // în memorie + persist pe disc
    settings: Arc<Mutex<SettingsJson>>, // register lock
    rate: Arc<Mutex<HashMap<String, RateBucket>>>,
}

// ========================= Utilitare =========================
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn now_s_f64() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}

fn rand_hex(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn hmac_sign(secret: &str, payload: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// comparație "constant-ish time" fără crate extern
fn timing_equal(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let len = ab.len().min(bb.len());
    let mut diff: usize = ab.len() ^ bb.len();
    for i in 0..len {
        diff |= (ab[i] ^ bb[i]) as usize;
    }
    diff == 0
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn is_image_mime(filename: &str) -> bool {
    let guess = mime_guess::from_path(filename).first_or_octet_stream();
    guess.type_() == mime::IMAGE
}

fn join_url(origin: &str, path: &str) -> String {
    if origin.ends_with('/') {
        format!("{}{}", origin.trim_end_matches('/'), path)
    } else {
        format!("{}{}", origin, path)
    }
}

// cookie utils
fn get_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let cookie_hdr = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie_hdr.split(';') {
        let mut it = part.trim().splitn(2, '=');
        let k = it.next()?.trim();
        let v = it.next().unwrap_or("");
        if k == name {
            return Some(v.to_string());
        }
    }
    None
}

fn set_cookie(name: &str, value: &str, max_age_days: i64, secure: bool) -> HeaderValue {
    let expires = chrono::Utc::now() + chrono::Duration::days(max_age_days);
    let cookie = format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax; Expires={}; {}",
        name,
        value,
        expires.format("%a, %d %b %Y %H:%M:%S GMT"),
        if secure { "Secure" } else { "" }
    );
    HeaderValue::from_str(&cookie).unwrap()
}

// ========================= ENV bootstrap =========================
fn read_env_file(path: &FsPath) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(raw) = fs::read_to_string(path) {
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(pos) = line.find('=') {
                let k = line[..pos].trim();
                let v = line[pos + 1..].trim();
                map.insert(k.to_string(), v.to_string());
            }
        }
    }
    map
}

fn write_env_file(path: &FsPath, kv: &HashMap<String, String>) -> io::Result<()> {
    let mut lines = vec!["# Auto-generated .env - do not commit to git".to_string()];
    let get = |k: &str, def: &str| kv.get(k).cloned().unwrap_or_else(|| def.to_string());

    lines.push(format!("PORT={}", get("PORT", &DEFAULT_PORT.to_string())));
    lines.push(format!(
        "PORT_HTTPS={}",
        get("PORT_HTTPS", &DEFAULT_PORT_HTTPS.to_string())
    ));
    lines.push(format!("UPLOAD_DIR={}", get("UPLOAD_DIR", DEFAULT_UPLOAD_DIR)));
    lines.push(format!(
        "MAX_UPLOAD_BYTES={}",
        get("MAX_UPLOAD_BYTES", &DEFAULT_MAX_UPLOAD_BYTES.to_string())
    ));
    lines.push(format!(
        "RATE_LIMIT_TOKENS={}",
        get("RATE_LIMIT_TOKENS", &DEFAULT_RATE_TOKENS.to_string())
    ));
    lines.push(format!(
        "RATE_LIMIT_REFILL={}",
        get("RATE_LIMIT_REFILL", &DEFAULT_RATE_REFILL.to_string())
    ));
    lines.push(format!(
        "SESSION_SECRET={}",
        get("SESSION_SECRET", &rand_hex(32))
    ));
    lines.push(format!(
        "UPLOAD_TOKEN_HASH={}",
        get("UPLOAD_TOKEN_HASH", "")
    ));
    lines.push(format!("SSL_KEY_PATH={}", get("SSL_KEY_PATH", "")));
    lines.push(format!("SSL_CERT_PATH={}", get("SSL_CERT_PATH", "")));
    if let Some(v) = kv.get("ADMIN_PASSWORD") {
        lines.push(format!("ADMIN_PASSWORD={}", v));
    }

    let mut f = fs::File::create(path)?;
    f.write_all(lines.join("\n").as_bytes())?;
    f.write_all(b"\n")
}

fn ensure_env(env_path: &FsPath) -> (Option<String>, HashMap<String, String>) {
    let mut kv = read_env_file(env_path);
    let mut initial_token_plain: Option<String> = None;
    let mut changed = false;

    if kv.get("SESSION_SECRET").is_none() {
        kv.insert("SESSION_SECRET".into(), rand_hex(32));
        changed = true;
    }

    if kv.get("UPLOAD_TOKEN_HASH").is_none() {
        let plain = rand_hex(24);
        let hash = bcrypt::hash(&plain, 10).expect("bcrypt");
        kv.insert("UPLOAD_TOKEN_HASH".into(), hash);
        initial_token_plain = Some(plain);
        changed = true;
    }
    if kv.get("PORT_HTTPS").is_none() {
        kv.insert("PORT_HTTPS".into(), DEFAULT_PORT_HTTPS.to_string());
        changed = true;
    }
    if kv.get("SSL_KEY_PATH").is_none() {
        kv.insert("SSL_KEY_PATH".into(), String::new());
        changed = true;
    }
    if kv.get("SSL_CERT_PATH").is_none() {
        kv.insert("SSL_CERT_PATH".into(), String::new());
        changed = true;
    }

    if changed {
        let _ = write_env_file(env_path, &kv);
    }

    // încărcăm și în process env (dotenvy)
    let _ = dotenvy::from_filename(env_path);

    (initial_token_plain, kv)
}

async fn ensure_data_and_admin(
    cfg: &Config,
    initial_admin_from_env: Option<String>,
) -> io::Result<Option<String>> {
    if !cfg.data_dir.exists() {
        tfs::create_dir_all(&cfg.data_dir).await?;
    }

    // users.json
    let mut first_admin_plain: Option<String> = None;

    if cfg.users_file.exists() {
        let raw = tfs::read(&cfg.users_file).await.unwrap_or_default();
        let mut parsed: UsersJson = serde_json::from_slice(&raw).unwrap_or_default();
        let mut mutated = false;
        for u in &mut parsed.users {
            if u.preferences.background.kind.is_empty() {
                u.preferences.background.kind = "color".into();
                mutated = true;
            }
            if u.preferences.background.value.is_empty() {
                u.preferences.background.value = DEFAULT_BG_COLOR.into();
                mutated = true;
            }
        }
        if mutated {
            tfs::write(&cfg.users_file, serde_json::to_vec_pretty(&parsed)?).await?;
        }
    } else {
        // fără useri -> creăm admin
        let admin_pass = if let Some(p) = initial_admin_from_env {
            p
        } else {
            rand_hex(8)
        };
        first_admin_plain = Some(admin_pass.clone());
        let hash = bcrypt::hash(admin_pass, 10).expect("bcrypt");
        let admin = User {
            username: "admin".into(),
            password_hash: hash,
            email: "admin@example.com".into(),
            created_at: now_ms(),
            role: "admin".into(),
            preferences: Preferences {
                background: BackgroundPref {
                    kind: "color".into(),
                    value: DEFAULT_BG_COLOR.into(),
                },
            },
            images: vec![],
        };
        let uj = UsersJson { users: vec![admin] };
        tfs::write(&cfg.users_file, serde_json::to_vec_pretty(&uj)?).await?;
    }

    // images.json
    if !cfg.images_file.exists() {
        let ij = ImagesJson::default();
        tfs::write(&cfg.images_file, serde_json::to_vec_pretty(&ij)?).await?;
    }

    // settings.json
    if !cfg.settings_file.exists() {
        let sj = SettingsJson::default();
        tfs::write(&cfg.settings_file, serde_json::to_vec_pretty(&sj)?).await?;
    }

    Ok(first_admin_plain)
}

async fn load_all(cfg: &Config) -> io::Result<(UsersJson, ImagesJson, SettingsJson)> {
    let uj: UsersJson = serde_json::from_slice(&tfs::read(&cfg.users_file).await.unwrap_or_default())
        .unwrap_or_default();
    let ij: ImagesJson =
        serde_json::from_slice(&tfs::read(&cfg.images_file).await.unwrap_or_default())
            .unwrap_or_default();
    let sj: SettingsJson =
        serde_json::from_slice(&tfs::read(&cfg.settings_file).await.unwrap_or_default())
            .unwrap_or_default();
    Ok((uj, ij, sj))
}

async fn save_users(cfg: &Config, users: &UsersJson) -> io::Result<()> {
    tfs::write(&cfg.users_file, serde_json::to_vec_pretty(users)?).await
}
async fn save_images(cfg: &Config, images: &ImagesJson) -> io::Result<()> {
    tfs::write(&cfg.images_file, serde_json::to_vec_pretty(images)?).await
}
async fn save_settings(cfg: &Config, settings: &SettingsJson) -> io::Result<()> {
    tfs::write(&cfg.settings_file, serde_json::to_vec_pretty(settings)?).await
}

// ========================= Rate limit =========================
fn allow_rate(state: &AppState, ip: &str) -> bool {
    let mut map = state.rate.lock();
    let b = map
        .entry(ip.to_string())
        .or_insert_with(|| RateBucket {
            tokens: state.cfg.rate_tokens,
            last: now_s_f64(),
        });
    let now = now_s_f64();
    let elapsed = (now - b.last).max(0.0) as f32;
    b.tokens = (b.tokens + elapsed * state.cfg.rate_refill).min(state.cfg.rate_tokens);
    b.last = now;
    if b.tokens >= 1.0 {
        b.tokens -= 1.0;
        true
    } else {
        false
    }
}

// ========================= Session =========================
fn sign_session(secret: &str, username: &str, ts: u64) -> String {
    let payload = format!("{}.{}", username, ts);
    let mac = hmac_sign(secret, &payload);
    format!("{}.{}", payload, mac)
}

fn verify_session(secret: &str, cookie_val: &str) -> Option<String> {
    let mut parts: Vec<&str> = cookie_val.split('.').collect();
    if parts.len() < 3 {
        return None;
    }
    let mac = parts.pop().unwrap();
    let ts = parts.pop().unwrap();
    let username = parts.join(".");
    let expected = hmac_sign(secret, &format!("{}.{}", username, ts));
    if !timing_equal(&expected, mac) {
        return None;
    }
    let ts_num = ts.parse::<u64>().ok()?;
    let age = now_ms().saturating_sub(ts_num);
    if age > SESSION_MAX_AGE_MS {
        return None;
    }
    Some(username)
}

fn check_auth(headers: &HeaderMap, state: &AppState) -> Option<String> {
    if let Some(val) = get_cookie(headers, "session") {
        verify_session(state.session_secret.as_str(), &val)
    } else {
        None
    }
}

// ========================= Helpers diverse =========================
fn get_origin(headers: &HeaderMap, scheme: &str, host: &str) -> String {
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(scheme);
    let host_hdr = headers
        .get("x-forwarded-host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(host);
    format!("{}://{}", proto, host_hdr)
}

fn prefer_https_origin(origin: &str, headers: &HeaderMap, state: &AppState) -> String {
    let req_proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");

    let https_possible = req_proto.eq_ignore_ascii_case("https")
        || (state.cfg.ssl_key_path.is_some() && state.cfg.ssl_cert_path.is_some());

    if https_possible && origin.starts_with("http://") {
        origin.replacen("http://", "https://", 1)
    } else {
        origin.to_string()
    }
}

fn client_user(user: &User) -> serde_json::Value {
    serde_json::json!({
        "username": user.username,
        "email": user.email,
        "created_at": user.created_at,
        "role": user.role,
        "backgroundPreference": user.preferences.background,
    })
}

fn find_user<'a>(users: &'a UsersJson, uname: &str) -> Option<&'a User> {
    users.users.iter().find(|u| u.username == uname)
}
fn find_user_mut<'a>(users: &'a mut UsersJson, uname: &str) -> Option<&'a mut User> {
    users.users.iter_mut().find(|u| u.username == uname)
}

fn find_user_by_email<'a>(users: &'a UsersJson, email: &str) -> Option<&'a User> {
    let lower = email.trim().to_lowercase();
    if lower.is_empty() {
        return None;
    }
    users.users.iter().find(|u| u.email.to_lowercase() == lower)
}

fn sanitize_filename(s: &str) -> String {
    let mut safe = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>();
    if safe.is_empty() {
        safe = "file".into();
    }
    safe
}

// ========================= Handlere =========================
#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

async fn api_login(
    State(state): State<AppState>,
    _headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    if body.username.is_empty() || body.password.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "username and password required");
    }

    let user_opt = {
        let users = state.users.lock();
        find_user(&users, &body.username).cloned()
    };
    let Some(user) = user_opt else {
        return json_error(StatusCode::UNAUTHORIZED, "Invalid credentials");
    };

    let ok = bcrypt::verify(&body.password, &user.password_hash).unwrap_or(false);
    if !ok {
        return json_error(StatusCode::UNAUTHORIZED, "Invalid credentials");
    }

    let ts = now_ms();
    let cookie_val = sign_session(state.session_secret.as_str(), &user.username, ts);
    let secure = std::env::var("NODE_ENV")
        .ok()
        .unwrap_or_default()
        .eq("production");
    let mut resp =
        Json(serde_json::json!({"success": true, "username": user.username, "email": user.email}))
            .into_response();
    resp.headers_mut()
        .append(header::SET_COOKIE, set_cookie("session", &cookie_val, 30, secure));
    resp
}

async fn api_logout() -> Response {
    let mut resp = Json(serde_json::json!({"success": true})).into_response();
    let del = HeaderValue::from_static("session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
    resp.headers_mut().append(header::SET_COOKIE, del);
    resp
}

async fn api_me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(username) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let users = state.users.lock();
    let Some(user) = find_user(&users, &username) else {
        return json_error(StatusCode::NOT_FOUND, "User not found");
    };
    Json(serde_json::json!({"success": true, "user": client_user(user)})).into_response()
}

#[derive(Deserialize)]
struct SettingsBody {
    currentPassword: Option<String>,
    newPassword: Option<String>,
    newUploadToken: Option<String>,
}

async fn api_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SettingsBody>,
) -> Response {
    let Some(username) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };

    // schimbare parolă
    if let Some(newp) = &body.newPassword {
        let Some(cur) = &body.currentPassword else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "currentPassword required to change password",
            );
        };

        let current_hash = {
            let users = state.users.lock();
            let Some(user) = find_user(&users, &username) else {
                return json_error(StatusCode::NOT_FOUND, "User not found");
            };
            user.password_hash.clone()
        };

        let ok = bcrypt::verify(cur, &current_hash).unwrap_or(false);
        if !ok {
            return json_error(StatusCode::UNAUTHORIZED, "Current password incorrect");
        }
        if newp.len() < 6 {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Password must be at least 6 characters",
            );
        }

        let hashed = bcrypt::hash(newp, 10).unwrap();
        let snapshot = {
            let mut users = state.users.lock();
            if let Some(user) = find_user_mut(&mut users, &username) {
                user.password_hash = hashed;
            }
            users.clone()
        };
        let _ = save_users(&state.cfg, &snapshot).await;
    }

    // schimbare upload token
    if let Some(newtok) = &body.newUploadToken {
        let Some(cur) = &body.currentPassword else {
            return json_error(
                StatusCode::BAD_REQUEST,
                "currentPassword required to change upload token",
            );
        };

        let current_hash = {
            let users = state.users.lock();
            let Some(user) = find_user(&users, &username) else {
                return json_error(StatusCode::NOT_FOUND, "User not found");
            };
            user.password_hash.clone()
        };
        let ok = bcrypt::verify(cur, &current_hash).unwrap_or(false);
        if !ok {
            return json_error(
                StatusCode::UNAUTHORIZED,
                "Current password incorrect (for upload token change)",
            );
        }
        if newtok.len() < 6 {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Upload token must be at least 6 chars",
            );
        }

        let new_hash = bcrypt::hash(newtok, 10).unwrap();
        {
            let mut h = state.upload_token_hash.lock();
            *h = new_hash;
        }
        *state.initial_upload_token_plain.lock() = Some(newtok.clone());
        let _ = persist_upload_token_in_env(&newtok);
    }

    Json(serde_json::json!({"success": true, "message": "Settings updated"})).into_response()
}

fn persist_upload_token_in_env(new_token_plain: &str) -> io::Result<()> {
    let env_path = FsPath::new(".env");
    let mut kv = read_env_file(env_path);
    let hash = bcrypt::hash(new_token_plain, 10).expect("bcrypt");
    kv.insert("UPLOAD_TOKEN_HASH".into(), hash);
    if kv.get("SESSION_SECRET").is_none() {
        kv.insert("SESSION_SECRET".into(), rand_hex(32));
    }
    write_env_file(env_path, &kv)
}

#[derive(Deserialize)]
struct EmailBody {
    email: String,
}

async fn api_update_email(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<EmailBody>,
) -> Response {
    let Some(username) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let new_email = body.email.trim();
    if new_email.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Email required");
    }
    if !new_email.contains('@') || !new_email.contains('.') {
        return json_error(StatusCode::BAD_REQUEST, "Invalid email format");
    }

    let (conflict, snapshot) = {
        let mut users = state.users.lock();
        let conflict = users
            .users
            .iter()
            .any(|u| u.username != username && u.email.eq_ignore_ascii_case(new_email));
        if conflict {
            (true, users.clone())
        } else {
            if let Some(u) = find_user_mut(&mut users, &username) {
                u.email = new_email.to_string();
            }
            (false, users.clone())
        }
    };

    if conflict {
        return json_error(StatusCode::CONFLICT, "Email already in use");
    }

    let _ = save_users(&state.cfg, &snapshot).await;
    Json(serde_json::json!({"success": true, "email": new_email, "message": "Email updated"}))
        .into_response()
}

async fn api_bg_templates(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if check_auth(&headers, &state).is_none() {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let templates = vec![
        "https://images.unsplash.com/photo-1526481280695-3c469be254d2?auto=format&fit=crop&w=1600&q=80",
        "https://cdn.wallpapersafari.com/72/26/fVpc1S.jpg",
        "https://i.imgur.com/bLxcjh3.png",
        "https://wallpapercave.com/wp/wp4511654.jpg",
    ];
    Json(serde_json::json!({"success": true, "templates": templates, "defaultBackground": {"type": "color", "value": DEFAULT_BG_COLOR} }))
        .into_response()
}

// =========== Upload helpers ===========
fn verify_upload_token(state: &AppState, candidate: &str) -> bool {
    if candidate.is_empty() {
        return false;
    }
    if let Some(ref plain) = *state.initial_upload_token_plain.lock() {
        if candidate == plain {
            return true;
        }
    }
    let hash = state.upload_token_hash.lock().clone();
    bcrypt::verify(candidate, &hash).unwrap_or(false)
}

fn ip_string(addr: Option<SocketAddr>) -> String {
    addr.map(|a| a.ip().to_string())
        .unwrap_or_else(|| "unknown".into())
}

// finalize upload (meta + legare user) + răspuns JSON {url, delete_url}
async fn finalize_upload(
    state: &AppState,
    headers: &HeaderMap,
    filename: String,
    originalname: String,
    size: u64,
    scheme: &str,
    host: &str,
) -> Response {
    let origin = get_origin(headers, scheme, host);
    let url = join_url(&origin, &format!("/i/{}", urlencoding::encode(&filename)));
    let id = Uuid::new_v4().to_string();

    let email_hdr = headers
        .get("x-user-email")
        .or_else(|| headers.get("x-useremail"))
        .or_else(|| headers.get("x-user_email"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let owner_username = {
        let users = state.users.lock();
        find_user_by_email(&users, email_hdr).map(|u| u.username.clone())
    };

    let meta = ImageMeta {
        id: id.clone(),
        filename: filename.clone(),
        originalname,
        size,
        url: url.clone(),
        uploaded_at: now_ms(),
        owner: owner_username.clone(),
    };

    // global images (snapshot & save)
    let img_snapshot = {
        let mut images = state.images.lock();
        images.images.push(meta.clone());
        images.clone()
    };
    let _ = save_images(&state.cfg, &img_snapshot).await;

    // atașare la user.images
    if let Some(owner) = owner_username {
        let users_snapshot = {
            let mut users = state.users.lock();
            if let Some(u) = find_user_mut(&mut users, &owner) {
                u.images.push(meta);
            }
            users.clone()
        };
        let _ = save_users(&state.cfg, &users_snapshot).await;
    }

    Json(serde_json::json!({"success": true, "url": url, "delete_url": join_url(&origin, &format!("/api/images/{}", id)) }))
        .into_response()
}

// ---------- Upload RAW (ShareX) ----------
async fn upload_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    // RATELIMIT + TOKEN
    let ip = headers
        .get("x-real-ip")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    let ip = if ip == "unknown" { "unknown".into() } else { ip };
    if !allow_rate(&state, &ip) {
        return json_error(StatusCode::TOO_MANY_REQUESTS, "Too many requests");
    }

    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !auth.starts_with("Bearer ") {
        return json_error(StatusCode::UNAUTHORIZED, "Missing Authorization header");
    }
    let token = &auth[7..];
    if !verify_upload_token(&state, token) {
        return json_error(StatusCode::UNAUTHORIZED, "Invalid upload token");
    }

    // nume fișier
    let filename_header = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .unwrap_or(&format!("{}.png", now_ms()))
        .to_string();
    let safe = sanitize_filename(&filename_header);
    let final_name = format!("{}-{}-{}", now_ms(), Uuid::new_v4(), safe);
    let filepath = state.cfg.upload_dir.join(&final_name);

    // deschide fișierul și scrie stream-ul pe disc
    let mut file = match tfs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&filepath)
        .await
    {
        Ok(f) => f,
        Err(_) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Upload error");
        }
    };

    let mut size: u64 = 0;
    let mut stream = body.into_data_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(_) => {
                let _ = tfs::remove_file(&filepath).await;
                return json_error(StatusCode::BAD_REQUEST, "Upload error");
            }
        };
        size += chunk.len() as u64;
        if size > state.cfg.max_upload_bytes {
            let _ = tfs::remove_file(&filepath).await;
            return json_error(StatusCode::PAYLOAD_TOO_LARGE, "File too large");
        }
        if let Err(_) = file.write_all(&chunk).await {
            let _ = tfs::remove_file(&filepath).await;
            return json_error(StatusCode::BAD_REQUEST, "Upload error");
        }
    }

    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // alege schema corectă (https dacă serverul are TLS configurat, altfel http)
    let have_tls = state.cfg.ssl_key_path.is_some() && state.cfg.ssl_cert_path.is_some();
    let scheme = if have_tls { "https" } else { "http" };

    finalize_upload(
        &state,
        &headers,
        final_name,
        filename_header,
        size,
        scheme,
        host,
    )
    .await
}

// ========================= Imagini publice =========================
async fn image_view(
    State(state): State<AppState>,
    Path(filename): Path<String>,
    headers: HeaderMap,
) -> Response {
    let file_path = state.cfg.upload_dir.join(&filename);
    if !file_path.starts_with(&state.cfg.upload_dir) || !file_path.exists() {
        return json_error(StatusCode::NOT_FOUND, "Not found");
    }

    let host   = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let origin_env_or_hdr = std::env::var("PUBLIC_ORIGIN")
        .unwrap_or_else(|_| get_origin(&headers, "http", host));
    let origin_best = prefer_https_origin(&origin_env_or_hdr, &headers, &state);

    let media_url = join_url(&origin_best, &format!("/i/{}", urlencoding::encode(&filename)));
    let page_url  = join_url(&origin_best, &format!("/i/{}/view", urlencoding::encode(&filename)));
    let title     = filename.clone();

    let mime     = mime_guess::from_path(&file_path).first_or_octet_stream();
    let is_video = mime.type_() == mime::VIDEO;

    // normalizăm tipul pt OG (Discord preferă video/mp4)
    let ext = std::path::Path::new(&filename).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let og_video_type = match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm"        => "video/webm",
        // unele .mov vin ca video/quicktime; Discord nu le iubește -> încearcă mp4
        "mov"         => "video/mp4",
        _             => mime.as_ref(), // fallback la ce a ghicit mime_guess
    };

    // forțăm URL-ul secure dacă pagina e https (Discord preferă secure_url)
    let media_url_https = if media_url.starts_with("http://") && origin_best.starts_with("https://") {
        media_url.replacen("http://", "https://", 1)
    } else {
        media_url.clone()
    };
    let is_https_media = media_url_https.starts_with("https://");

    let media_tag = if is_video {
        format!(
            "<video src=\"{}\" controls preload=\"metadata\" playsinline style=\"max-width:100%;max-height:80vh;border:6px solid rgba(255,255,255,0.06);box-shadow:0 6px 18px rgba(0,0,0,0.2);border-radius:8px\"></video>",
            escape_html(&media_url_https)
        )
    } else {
        format!(
            "<img src=\"{}\" alt=\"Shared file\" style=\"max-width:100%;max-height:80vh;border:6px solid rgba(255,255,255,0.06);box-shadow:0 6px 18px rgba(0,0,0,0.2);border-radius:8px\"/>",
            escape_html(&media_url)
        )
    };

    // --- OG pentru Discord: video ---
    let og_block = if is_video {
        use std::fmt::Write as _;
        let mut meta = String::new();

        // Tipul OG de pagină + video URL + tip + dimensiuni
        let _ = write!(
            meta,
            r#"<meta property="og:type" content="video.other">
               <meta property="og:video" content="{u}">
               <meta property="og:video:type" content="{t}">
               <meta property="og:video:width" content="1280">
               <meta property="og:video:height" content="720">"#,
            u = escape_html(&media_url_https),
            t = escape_html(og_video_type)
        );

        // secure_url dacă avem https
        if is_https_media {
            let _ = write!(
                meta,
                r#"<meta property="og:video:secure_url" content="{u}">"#,
                u = escape_html(&media_url_https)
            );
        }

        // og:image e recomandat (folosim video ca fallback poster)
        let _ = write!(
            meta,
            r#"<meta property="og:image" content="{img}">
               <meta name="twitter:card" content="player">"#,
            img = escape_html(&media_url_https)
        );

        meta
    } else {
        // --- OG pentru imagini ---
        format!(
            r#"<meta property="og:image" content="{}">
               <meta property="og:type" content="article">
               <meta name="twitter:card" content="summary_large_image">"#,
            escape_html(&media_url)
        )
    };

    let html = format!(
        "<!doctype html><html lang=\"en\"><head>
         <meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
         <title>{}</title>
         <meta property=\"og:site_name\" content=\"ADEdge\">
         <meta property=\"og:title\" content=\"{}\">
         <meta property=\"og:description\" content=\"uploaded on ADEdge\">
         <meta property=\"og:url\" content=\"{}\">
         {}
         <style>
           html,body{{height:100%;margin:0}}
           body{{display:flex;align-items:center;justify-content:center;background:#0f9d58;color:#0a0a0a;font-family:Arial,Helvetica,sans-serif}}
           .container{{max-width:90%;max-height:90%;display:flex;align-items:center;justify-content:center;flex-direction:column}}
           .note{{margin-top:12px;color:rgba(255,255,255,0.9);font-size:14px}}
         </style></head><body>
         <div class=\"container\">{}<div class=\"note\">This file was uploaded on ADEdge.</div></div>
         </body></html>",
        escape_html(&title),
        escape_html(&title),
        escape_html(&page_url),
        og_block,
        media_tag
    );

    ([
        (header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8")),
        (header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=60")),
    ], Html(html)).into_response()
}

async fn image_raw(
    State(state): State<AppState>,
    Path(filename): Path<String>,
    headers: HeaderMap
) -> Response {
    let file_path = state.cfg.upload_dir.join(&filename);
    if !file_path.starts_with(&state.cfg.upload_dir) || !file_path.exists() {
        return json_error(StatusCode::NOT_FOUND, "Not found");
    }

    let mime = mime_guess::from_path(&file_path).first_or_octet_stream();
    let mut file = match tfs::File::open(&file_path).await {
        Ok(f) => f,
        Err(_) => return json_error(StatusCode::NOT_FOUND, "Not found"),
    };
    let total_len = file.metadata().await.map(|m| m.len()).unwrap_or(0);

    let range_hdr = headers.get(header::RANGE).and_then(|v| v.to_str().ok()).unwrap_or("");
    if let Some(rest) = range_hdr.strip_prefix("bytes=") {
        let mut start = 0u64;
        let mut end   = total_len.saturating_sub(1);

        if let Some((s, e)) = rest.split_once('-') {
            if !s.is_empty() { if let Ok(v) = s.parse() { start = v; } }
            if !e.is_empty() { if let Ok(v) = e.parse() { end = v; } }
            if end >= total_len { end = total_len - 1; }
            if start > end { return (StatusCode::RANGE_NOT_SATISFIABLE, "").into_response(); }
        }

        let len = end - start + 1;
        let _ = file.seek(SeekFrom::Start(start)).await;
        let reader = file.take(len);
        let stream = ReaderStream::new(reader);

        let mut resp = Response::new(Body::from_stream(stream));
        *resp.status_mut() = StatusCode::PARTIAL_CONTENT;
        resp.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(mime.as_ref()).unwrap_or(HeaderValue::from_static("application/octet-stream")),
        );
        resp.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {}-{}/{}", start, end, total_len)).unwrap(),
        );
        resp.headers_mut().insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&len.to_string()).unwrap(),
        );
        resp.headers_mut().insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
        resp.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_static("inline"),
        );
        return resp;
    }

    // fără Range -> full
    let stream = ReaderStream::new(file);
    let mut resp = Response::new(Body::from_stream(stream));
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref()).unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    resp.headers_mut().insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    resp.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&total_len.to_string()).unwrap(),
    );
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline"),
    );
    resp
}

async fn image_head(
    State(state): State<AppState>,
    Path(filename): Path<String>,
) -> Response {
    let file_path = state.cfg.upload_dir.join(&filename);
    if !file_path.starts_with(&state.cfg.upload_dir) || !file_path.exists() {
        return (StatusCode::NOT_FOUND, "").into_response();
    }
    let mime = mime_guess::from_path(&file_path).first_or_octet_stream();
    let len  = fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);

    let mut resp = Response::new(Body::empty());
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref()).unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    resp.headers_mut().insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    resp.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&len.to_string()).unwrap(),
    );
    resp.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline"),
    );
    resp
}

// ========================= Imagini API =========================
async fn api_images_list(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(username) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    let users = state.users.lock();
    let Some(u) = find_user(&users, &username) else {
        return json_error(StatusCode::NOT_FOUND, "User not found");
    };
    Json(serde_json::json!({"success": true, "images": u.images})).into_response()
}

#[derive(Deserialize)]
struct DelByFilename {
    filename: String,
}

async fn api_images_delete_by_filename(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<DelByFilename>,
) -> Response {
    let Some(username) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    if body.filename.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Missing filename");
    }
    let safe = FsPath::new(&body.filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let file_path = state.cfg.upload_dir.join(&safe);

    // 1. șterge de pe disc (best-effort)
    if file_path.starts_with(&state.cfg.upload_dir) {
        let _ = tfs::remove_file(&file_path).await;
    }

    // 2. curăță din images.json
    let img_snapshot = {
        let mut images = state.images.lock();
        images.images.retain(|img| img.filename != safe);
        images.clone()
    };
    let _ = save_images(&state.cfg, &img_snapshot).await;

    // 3. curăță din users.json
    let users_snapshot = {
        let mut users = state.users.lock();
        for u in users.users.iter_mut() {
            u.images.retain(|m| m.filename != safe);
        }
        users.clone()
    };
    let _ = save_users(&state.cfg, &users_snapshot).await;

    Json(serde_json::json!({"success": true})).into_response()
}

async fn api_images_delete_by_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let Some(username) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };

    // scoatem din user + salvăm users.json
    let (maybe_item, users_snapshot) = {
        let mut users = state.users.lock();
        let Some(u) = find_user_mut(&mut users, &username) else {
            return json_error(StatusCode::NOT_FOUND, "User not found");
        };
        let pos = u.images.iter().position(|i| i.id == id);
        let item = pos.map(|p| u.images.remove(p));
        (item, users.clone())
    };

    let Some(item) = maybe_item else {
        return json_error(StatusCode::NOT_FOUND, "Not found or not owned");
    };

    let _ = save_users(&state.cfg, &users_snapshot).await;

    // șterge fișier
    let path = state.cfg.upload_dir.join(&item.filename);
    let _ = tfs::remove_file(&path).await;

    // scoate din global images
    let img_snapshot = {
        let mut images = state.images.lock();
        images.images.retain(|m| m.id != item.id);
        images.clone()
    };
    let _ = save_images(&state.cfg, &img_snapshot).await;

    Json(serde_json::json!({"success": true})).into_response()
}

// ========================= Upload cu sesiune (dashboard) =========================
async fn api_upload_dashboard(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    let Some(username) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    while let Some(field) = multipart.next_field().await.unwrap_or(None) {
        if field.name().unwrap_or("") == "file" {
            // IMPORTANT: copiem numele într-un String înainte să "mutăm" field
            let filename_raw = field.file_name().unwrap_or("file").to_string();
            let safe = sanitize_filename(&filename_raw);
            let final_name = format!("{}-{}-{}", now_ms(), Uuid::new_v4(), safe);
            let filepath = state.cfg.upload_dir.join(&final_name);
            let mut file = match tfs::File::create(&filepath).await {
                Ok(f) => f,
                Err(_) => return json_error(StatusCode::BAD_REQUEST, "Upload error"),
            };
            let mut size: u64 = 0;
            let mut stream = field;
            while let Some(chunk) = stream.chunk().await.unwrap() {
                size += chunk.len() as u64;
                if size > state.cfg.max_upload_bytes {
                    let _ = tfs::remove_file(&filepath).await;
                    return json_error(StatusCode::PAYLOAD_TOO_LARGE, "File too large");
                }
                if let Err(_) = file.write_all(&chunk).await {
                    let _ = tfs::remove_file(&filepath).await;
                    return json_error(StatusCode::BAD_REQUEST, "Upload error");
                }
            }

            let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
            // alege schema corectă pentru dashboard
            let have_tls = state.cfg.ssl_key_path.is_some() && state.cfg.ssl_cert_path.is_some();
            let scheme = if have_tls { "https" } else { "http" };
            let origin = get_origin(&headers, scheme, host);
            let url = join_url(&origin, &format!("/i/{}", urlencoding::encode(&final_name)));
            let id = Uuid::new_v4().to_string();
            let meta = ImageMeta {
                id: id.clone(),
                filename: final_name.clone(),
                originalname: filename_raw,
                size,
                url: url.clone(),
                uploaded_at: now_ms(),
                owner: Some(username.clone()),
            };

            // images.json
            let img_snapshot = {
                let mut images = state.images.lock();
                images.images.push(meta.clone());
                images.clone()
            };
            let _ = save_images(&state.cfg, &img_snapshot).await;

            // users.json
            let users_snapshot = {
                let mut users = state.users.lock();
                if let Some(u) = find_user_mut(&mut users, &username) {
                    u.images.push(meta);
                }
                users.clone()
            };
            let _ = save_users(&state.cfg, &users_snapshot).await;

            return Json(serde_json::json!({"success": true, "url": url})).into_response();
        }
    }
    json_error(StatusCode::BAD_REQUEST, "No file")
}

// ========================= Admin =========================
async fn admin_users_list(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(username) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    if username != "admin" {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    let users = state.users.lock();
    let list: Vec<_> = users.users.iter().map(client_user).collect();
    Json(serde_json::json!({"success": true, "users": list})).into_response()
}

#[derive(Deserialize)]
struct AdminCreate {
    newUsername: String,
    email: String,
    password: String,
}

async fn admin_users_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AdminCreate>,
) -> Response {
    let Some(actor) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    if actor != "admin" {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    if body.newUsername.trim().len() < 3 || body.newUsername.len() > 32 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Username must be 3-32 characters",
        );
    }
    if !body.email.contains('@') {
        return json_error(StatusCode::BAD_REQUEST, "Email invalid");
    }
    if body.password.len() < 6 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Password must be at least 6 characters",
        );
    }

    // construim user + out înainte de push
    let new_user = User {
        username: body.newUsername.clone(),
        password_hash: bcrypt::hash(&body.password, 10).unwrap(),
        email: body.email.clone(),
        created_at: now_ms(),
        role: "user".into(),
        preferences: Preferences {
            background: BackgroundPref {
                kind: "color".into(),
                value: DEFAULT_BG_COLOR.into(),
            },
        },
        images: vec![],
    };
    let out_val = client_user(&new_user);

    // verificări + push + save
    let (exists_u, exists_e, users_snapshot) = {
        let mut users = state.users.lock();
        let exists_u = users.users.iter().any(|u| u.username == new_user.username);
        let exists_e = users
            .users
            .iter()
            .any(|u| u.email.eq_ignore_ascii_case(&new_user.email));
        if !exists_u && !exists_e {
            users.users.push(new_user);
        }
        (exists_u, exists_e, users.clone())
    };

    if exists_u {
        return json_error(StatusCode::CONFLICT, "Username already exists");
    }
    if exists_e {
        return json_error(StatusCode::CONFLICT, "Email already exists");
    }

    let _ = save_users(&state.cfg, &users_snapshot).await;
    Json(serde_json::json!({"success": true, "user": out_val})).into_response()
}

async fn admin_users_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(username): Path<String>,
) -> Response {
    let Some(actor) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    if actor != "admin" {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    if username == "admin" {
        return json_error(StatusCode::BAD_REQUEST, "Cannot delete admin account");
    }

    let (found, users_snapshot) = {
        let mut users = state.users.lock();
        let before = users.users.len();
        users.users.retain(|u| u.username != username);
        let found = before != users.users.len();
        (found, users.clone())
    };

    if !found {
        return json_error(StatusCode::NOT_FOUND, "User not found");
    }

    let _ = save_users(&state.cfg, &users_snapshot).await;
    Json(serde_json::json!({"success": true})).into_response()
}

async fn admin_register_get(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(actor) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    if actor != "admin" {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    let blocked = state.settings.lock().registerBlocked;
    Json(serde_json::json!({"blocked": blocked})).into_response()
}

#[derive(Deserialize)]
struct RegisterBlockedBody {
    blocked: serde_json::Value,
}

async fn admin_register_set(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RegisterBlockedBody>,
) -> Response {
    let Some(actor) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };
    if actor != "admin" {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }

    let val = match body.blocked {
        serde_json::Value::Bool(b) => b,
        serde_json::Value::String(ref s) if s == "true" => true,
        _ => false,
    };

    let settings_snapshot = {
        let mut s = state.settings.lock();
        s.registerBlocked = val;
        s.clone()
    };
    let _ = save_settings(&state.cfg, &settings_snapshot).await;

    Json(serde_json::json!({
        "success": true,
        "blocked": val
    }))
    .into_response()
}

// ========================= Register public =========================
#[derive(Deserialize)]
struct RegisterBody {
    username: String,
    email: String,
    password: String,
}

async fn public_register(
    State(state): State<AppState>,
    Json(body): Json<RegisterBody>,
) -> Response {
    if state.settings.lock().registerBlocked {
        return json_error(
            StatusCode::FORBIDDEN,
            "Registration is currently disabled.",
        );
    }
    let uname = body.username.trim();
    let email = body.email.trim();
    let pass = body.password.as_str();

    if uname.len() < 3
        || uname.len() > 32
        || !uname
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Username must be 3-32 chars (letters / numbers / . _ - ).",
        );
    }
    if !email.contains('@') || !email.contains('.') {
        return json_error(StatusCode::BAD_REQUEST, "Invalid email format.");
    }
    if pass.len() < 6 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Password must be at least 6 characters.",
        );
    }

    // verificări + push + save
    let (exists_u, exists_e, users_snapshot) = {
        let mut users = state.users.lock();
        let exists_u = users.users.iter().any(|u| u.username == uname);
        let exists_e = users
            .users
            .iter()
            .any(|u| u.email.eq_ignore_ascii_case(email));
        if !exists_u && !exists_e {
            let hash = bcrypt::hash(pass, 10).unwrap();
            let user = User {
                username: uname.into(),
                password_hash: hash,
                email: email.into(),
                created_at: now_ms(),
                role: "user".into(),
                preferences: Preferences {
                    background: BackgroundPref {
                        kind: "color".into(),
                        value: DEFAULT_BG_COLOR.into(),
                    },
                },
                images: vec![],
            };
            users.users.push(user);
        }
        (exists_u, exists_e, users.clone())
    };

    if exists_u {
        return json_error(StatusCode::CONFLICT, "Username already exists.");
    }
    if exists_e {
        return json_error(StatusCode::CONFLICT, "Email already exists.");
    }

    let _ = save_users(&state.cfg, &users_snapshot).await;
    Json(serde_json::json!({"ok": true, "message": "User created.", "user": {"username": uname, "email": email, "role": "user"} }))
        .into_response()
}

// ========================= ShareX .sxcu =========================

fn host_from_url(u: &str) -> Option<String> {
    let after = u.split("://").nth(1)?;
    let host = after.split('/').next().unwrap_or("").trim();
    if host.is_empty() { None } else { Some(host.to_string()) }
}

fn resolve_public_origin(state: &AppState, headers: &HeaderMap) -> String {
    if let Ok(env_o) = std::env::var("PUBLIC_ORIGIN") {
        let env_o = env_o.trim().trim_end_matches('/').to_string();
        if !env_o.is_empty() {
            return env_o;
        }
    }

    let https_available = state.cfg.ssl_key_path.is_some() && state.cfg.ssl_cert_path.is_some();
    let scheme = if https_available { "https" } else { "http" };

    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).and_then(host_from_url))
        .or_else(|| headers.get(header::REFERER).and_then(|v| v.to_str().ok()).and_then(host_from_url))
        .unwrap_or_else(|| {
            if https_available {
                format!("localhost:{}", state.cfg.https_port)
            } else {
                format!("localhost:{}", state.cfg.http_port)
            }
        });

    format!("{}://{}", scheme, host)
}

#[axum::debug_handler]
#[axum::debug_handler]
async fn generate_sxcu(state: AppState, headers: HeaderMap) -> Response {
    // 1) auth
    let Some(username) = check_auth(&headers, &state) else {
        return json_error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };

    // 2) citește email fără să ții lock la await
    let email = {
        let users = state.users.lock();
        find_user(&users, &username)
            .map(|u| u.email.clone())
            .unwrap_or_default()
    }; // <- lock eliberat aici

    // 3) vezi dacă ai deja un token în memorie (NU ține lock peste await)
    let maybe_plain: Option<String> = {
        let g = state.initial_upload_token_plain.lock();
        g.clone()
    }; // <- lock eliberat aici

    // 4) fie folosești tokenul existent, fie creezi unul nou (cu hash în thread pool)
    let token = if let Some(t) = maybe_plain {
        t
    } else {
        let new_tok = rand_hex(24);

        // calculează hash-ul într-un thread de blocking
        let new_hash = match tokio::task::spawn_blocking({
            let t = new_tok.clone();
            move || bcrypt::hash(t, 10)
        })
        .await
        {
            Ok(Ok(h)) => h,
            _ => return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Could not hash token"),
        };

        // scrie hash-ul (scurt lock, fără await)
        {
            let mut h = state.upload_token_hash.lock();
            *h = new_hash;
        }
        {
            let mut p = state.initial_upload_token_plain.lock();
            *p = Some(new_tok.clone());
        }

        new_tok
    };

    // 5) origin corect (https dacă ai cheie+cert în .env, altfel http; sau PUBLIC_ORIGIN)
    let origin = resolve_public_origin(&state, &headers);
    let base = origin.trim_end_matches('/');

    // 6) payload ShareX
    let sxcu = serde_json::json!({
        "Version": "17.0.0",
        "Name": format!("ADEdge uploader ({})", base),
        "DestinationType": "ImageUploader, TextUploader, FileUploader",
        "RequestMethod": "POST",
        "RequestURL": format!("{}/upload", base),
        "Headers": {
            "Authorization": format!("Bearer {}", token),
            "X-User-Email": email,
            "X-Filename": "{filename}"
        },
        "Body": "Binary",
        "URL": "{json:url}/view",
        "DeletionURL": "{json:delete_url}"
    });

    ([
        (header::CONTENT_TYPE, HeaderValue::from_static("application/json")),
        (header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment; filename=ADEdge.sxcu")),
    ], Json(sxcu)).into_response()
}

// ========================= JSON helper =========================
fn json_error(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({"success": false, "error": msg}))).into_response()
}

async fn redirect_http(Host(host): Host, OriginalUri(uri): OriginalUri) -> Redirect {
    Redirect::permanent(&format!("https://{}{}", host, uri))
}

// ========================= Pagini de bază =========================
async fn static_file(path: &PathBuf) -> Response {
    match tfs::read(path).await {
        Ok(bytes) => {
            let mut resp = Response::new(Body::from(bytes));
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
            resp
        }
        Err(_) => (StatusCode::NOT_FOUND, "").into_response(),
    }
}

async fn root(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if check_auth(&headers, &state).is_some() {
        static_file(&state.cfg.public_dir.join("dashboard.html")).await
    } else {
        static_file(&state.cfg.public_dir.join("login.html")).await
    }
}

async fn settings_page(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if check_auth(&headers, &state).is_none() {
        return static_file(&state.cfg.public_dir.join("login.html")).await;
    }
    static_file(&state.cfg.public_dir.join("settings.html")).await
}

async fn dashboard_page(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if check_auth(&headers, &state).is_none() {
        return static_file(&state.cfg.public_dir.join("login.html")).await;
    }
    static_file(&state.cfg.public_dir.join("dashboard.html")).await
}

async fn reg_html_404() -> Response {
    (StatusCode::NOT_FOUND, "").into_response()
}

async fn register_page(State(state): State<AppState>) -> Response {
    if state.settings.lock().registerBlocked {
        return (StatusCode::FORBIDDEN, "").into_response();
    }
    static_file(&state.cfg.public_dir.join("register.html")).await
}

async fn healthz() -> Response {
    Json(serde_json::json!({"ok": true})).into_response()
}

// ========================= Start server =========================
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // .env bootstrap
    let env_path = FsPath::new(".env");
    let (initial_upload_token_plain, env_kv) = ensure_env(env_path);

    // config
    let http_port = env_kv
        .get("PORT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let https_port = env_kv
        .get("PORT_HTTPS")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT_HTTPS);
    let upload_dir =
        PathBuf::from(env_kv.get("UPLOAD_DIR").cloned().unwrap_or_else(|| DEFAULT_UPLOAD_DIR.into()));
    let background_dir = upload_dir.join("backgrounds");
    let public_dir = PathBuf::from("public");
    let dashboard_html = public_dir.join("dashboard.html");

    let data_dir = PathBuf::from("data");
    let users_file = data_dir.join("users.json");
    let images_file = data_dir.join("images.json");
    let settings_file = data_dir.join("settings.json");

    let max_upload_bytes = env_kv
        .get("MAX_UPLOAD_BYTES")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_UPLOAD_BYTES);
    let rate_tokens = env_kv
        .get("RATE_LIMIT_TOKENS")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_RATE_TOKENS);
    let rate_refill = env_kv
        .get("RATE_LIMIT_REFILL")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_RATE_REFILL);

    let ssl_key_path = env_kv
        .get("SSL_KEY_PATH")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let ssl_cert_path = env_kv
        .get("SSL_CERT_PATH")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    if !upload_dir.exists() {
        tfs::create_dir_all(&upload_dir).await?;
    }
    if !background_dir.exists() {
        tfs::create_dir_all(&background_dir).await?;
    }

    let cfg = Config {
        http_port,
        https_port,
        upload_dir,
        background_dir,
        public_dir,
        dashboard_html,
        data_dir,
        users_file,
        images_file,
        settings_file,
        max_upload_bytes,
        rate_tokens,
        rate_refill,
        ssl_key_path,
        ssl_cert_path,
    };

    let admin_pass_env = env_kv.get("ADMIN_PASSWORD").cloned();
    let first_admin_pass = ensure_data_and_admin(&cfg, admin_pass_env).await?;

    let (users, images, settings) = load_all(&cfg).await?;

    let session_secret = env_kv
        .get("SESSION_SECRET")
        .cloned()
        .unwrap_or_else(|| rand_hex(32));
    let upload_token_hash = env_kv
        .get("UPLOAD_TOKEN_HASH")
        .cloned()
        .unwrap_or_default();

    let state = AppState {
        cfg: Arc::new(cfg),
        session_secret: Arc::new(session_secret),
        upload_token_hash: Arc::new(Mutex::new(upload_token_hash)),
        initial_upload_token_plain: Arc::new(Mutex::new(initial_upload_token_plain)),
        initial_admin_pass_plain: Arc::new(Mutex::new(first_admin_pass)),
        users: Arc::new(Mutex::new(users)),
        images: Arc::new(Mutex::new(images)),
        settings: Arc::new(Mutex::new(settings)),
        rate: Arc::new(Mutex::new(HashMap::new())),
    };

    // logging
    println!("Uploads dir: {}", state.cfg.upload_dir.display());
    println!(
        "Registration lock: {}",
        if state.settings.lock().registerBlocked {
            "BLOCKED"
        } else {
            "OPEN"
        }
    );
    if let Some(tok) = &*state.initial_upload_token_plain.lock() {
        println!("===================================================================");
        println!("FIRST RUN: a UPLOAD TOKEN was generated automatically (one-time). Copy it now:");
        println!("{}", tok);
        println!("===================================================================");
    } else {
        println!("If you need an upload token, set it via Settings -> Set new Upload Token.");
    }
    if let Some(p) = &*state.initial_admin_pass_plain.lock() {
        println!("===================================================================");
        println!("FIRST RUN: default admin created. Username: admin");
        println!("Password (one-time, copy it now):");
        println!("{}", p);
        println!("Change it ASAP in Settings.");
        println!("===================================================================");
    } else {
        println!("Admin user exists (or was created earlier).");
    }

    // Router
    let app = Router::new()
        // public image endpoints
        .route("/i/:filename/view", get(image_view))
        .route("/i/:filename", get(image_raw).head(image_head))
        // upload (ShareX RAW + dashboard multipart)
        .route("/upload", post(upload_handler))
        // auth
        .route("/api/login", post(api_login))
        .route("/api/logout", post(api_logout))
        // account
        .route("/api/me", get(api_me))
        .route("/api/account/me", get(api_me))
        .route("/dashboard", get(dashboard_page))
        .route("/api/settings", post(api_settings))
        .route("/api/account/settings", post(api_settings))
        .route("/api/account/email", post(api_update_email))
        .route("/api/account/background/templates", get(api_bg_templates))
        // images
        .route("/api/images", get(api_images_list).delete(api_images_delete_by_filename))
        .route("/api/images/:id", delete(api_images_delete_by_id))
        .route("/api/upload", post(api_upload_dashboard))
        // admin
        .route("/api/account/users", get(admin_users_list).post(admin_users_create))
        .route("/api/account/users/:username", delete(admin_users_delete))
        .route("/api/admin/register", get(admin_register_get).post(admin_register_set))
        // register public
        .route("/register.html", get(reg_html_404))
        .route("/register", get(register_page).post(public_register))
        // sxcu
.route(
    "/api/generate-sxcu",
    get(|State(state): State<AppState>, headers: HeaderMap| async move {
        generate_sxcu(state, headers).await
    })
    .post(|State(state): State<AppState>, headers: HeaderMap| async move {
        generate_sxcu(state, headers).await
    })
)
        .route("/healthz", get(healthz))
        .route(
            "/login",
            get(|State(state): State<AppState>| async move {
                static_file(&state.cfg.public_dir.join("login.html")).await
            }),
        )
        // pages
        .route("/", get(root))
        .route("/settings", get(settings_page))
        // static public + backgrounds dir
        .nest_service("/public", ServeDir::new(state.cfg.public_dir.clone()))
        .nest_service("/backgrounds", ServeDir::new(state.cfg.background_dir.clone()))
        // setează limita de body (pentru stream upload RAW)
        .layer(axum::extract::DefaultBodyLimit::max(
            state.cfg.max_upload_bytes as usize,
        ))
        .with_state(state.clone());

    // ===== HTTP și HTTPS =====
    let http_addr  = SocketAddr::from(([0,0,0,0], state.cfg.http_port));
    let https_addr = SocketAddr::from(([0,0,0,0], state.cfg.https_port));

    let have_tls = state.cfg.ssl_key_path.is_some() && state.cfg.ssl_cert_path.is_some();

    if have_tls {
        let cert_path = state.cfg.ssl_cert_path.clone().unwrap();
        let key_path  = state.cfg.ssl_key_path.clone().unwrap();

        let tls_config = RustlsConfig::from_pem_file(cert_path.clone(), key_path.clone()).await?;

        println!("HTTPS server pornit: https://localhost:{}", state.cfg.https_port);

        // HTTPS serve app-ul tău
        let https_srv = axum_server::bind_rustls(https_addr, tls_config)
            .serve(app.clone().into_make_service_with_connect_info::<SocketAddr>());

        // HTTP → redirect către HTTPS
        let redirect_app = Router::new().fallback(redirect_http);
        let http_listener = tokio::net::TcpListener::bind(http_addr).await?;
        println!("HTTP redirect activ:  http://localhost:{} → HTTPS", state.cfg.http_port);
        let http_srv = axum::serve(
            http_listener,
            redirect_app.into_make_service_with_connect_info::<SocketAddr>(),
        );

        tokio::select! {
            res = https_srv => { if let Err(e) = res { eprintln!("HTTPS error: {}", e); } },
            res = http_srv  => { if let Err(e) = res { eprintln!("HTTP redirect error: {}", e); } },
            _ = shutdown_signal() => { println!("Received shutdown, closing..."); }
        }
    } else {
        // Fără TLS în .env → doar HTTP
        let http_listener = tokio::net::TcpListener::bind(http_addr).await?;
        println!("HTTP server pornit:  http://localhost:{}", state.cfg.http_port);

        let http_server = axum::serve(
            http_listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        );

        tokio::select! {
            res = http_server => { if let Err(e) = res { eprintln!("HTTP error: {}", e); } },
            _ = shutdown_signal() => { println!("Received shutdown, closing..."); }
        }
    }

    Ok(())
}

async fn shutdown_signal() {
    let _ = signal::ctrl_c().await;
}
