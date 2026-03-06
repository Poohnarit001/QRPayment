/* Settings page: Config + Image + GPS + OTA */
"use strict";

const $ = (id) => document.getElementById(id);

/* ===== UI helpers ===== */
function escapeHtml(s){
  return String(s||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

function badgeHtml(cls, text){
  return `<span class="badge ${cls}"><span class="badgeDot"></span>${escapeHtml(text)}</span>`;
}
function fmtLatLonShort(lat, lon){
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function toast(title, msg, type){
  const t = $("toast");
  if (!t) return;

  const ttl = String(title || "");
  const mm = String(msg || "");

  let ty = String(type || "").toLowerCase();
  if (!ty){
    const u = ttl.toUpperCase();
    if (u.includes("FAIL") || u.includes("ERROR")) ty = "error";
    else if (u.includes("WARN") || u.includes("TIMEOUT") || u.includes("NO DATA")) ty = "warn";
    else if (u.includes("SAVED") || u.includes("LOADED") || u.includes("OK") || u.includes("UPLOADED")) ty = "success";
    else ty = "info";
  }

  const icon = ty === "success" ? "✓"
             : ty === "warn" ? "!"
             : ty === "error" ? "×"
             : "i";

  t.classList.remove("tSuccess","tWarn","tError","tInfo","isShow");
  t.classList.add("toast","isShow",
    ty === "success" ? "tSuccess" :
    ty === "warn" ? "tWarn" :
    ty === "error" ? "tError" : "tInfo"
  );

  t.hidden = false;
  t.innerHTML = `
    <div class="tRow">
      <div class="tIcon" aria-hidden="true">${escapeHtml(icon)}</div>
      <div>
        <div class="tTitle">${escapeHtml(ttl)}</div>
        <div class="tMsg">${escapeHtml(mm)}</div>
      </div>
    </div>
  `;

  clearTimeout(toast._tm);
  toast._tm = setTimeout(()=>{
    t.classList.remove("isShow");
    t.hidden = true;
  }, 2300);
}


async function fetchJSON(url){
  const r = await fetch(url, { cache: "no-store" });
  if (r.status === 204) return null;
  const ct = r.headers.get("content-type") || "";
  const isJson = ct.includes("application/json");
  const body = isJson ? await r.json().catch(()=>null) : await r.text().catch(()=>"");
  if (!r.ok) {
    const msg = (body && typeof body === "object") ? (body.error || body.detail || `HTTP ${r.status}`) : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body;
}

function parsePosInt(v){
  const n = Number(String(v ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/* ===== Time format (dd/mm + Buddhist year) ===== */
function pad2(n){ return String(Number(n||0)).padStart(2,"0"); }
function toThaiDateTime(ts){
  const d = new Date(Number(ts) || Date.now());
  const dd = pad2(d.getDate());
  const mm = pad2(d.getMonth()+1);
  const yyyy = d.getFullYear() + 543; // Buddhist Era
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
}

function fmtLatLon(lat, lon){
  const a = Number(lat), b = Number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "-";
  return `${a.toFixed(6)}, ${b.toFixed(6)}`;
}

/* ===== Theme ===== */
function setTheme(theme){
  const root = document.documentElement;
  root.classList.add("theme-switching");
  root.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  const icon = $("themeIcon");
  if (icon) icon.textContent = theme === "dark" ? "☾" : "☀";

  clearTimeout(setTheme._tm);
  setTheme._tm = setTimeout(() => root.classList.remove("theme-switching"), 200);
}
function toggleTheme(){
  const now = document.documentElement.getAttribute("data-theme") || "dark";
  setTheme(now === "dark" ? "light" : "dark");
}

/* ===== Query helpers ===== */
function getQueryDevice(){
  const sp = new URLSearchParams(location.search);
  return (sp.get("device_id") || "").trim().toUpperCase();
}

/* =====================================================================================
   1) Device Config
===================================================================================== */
async function fetchDeviceConfig(dev){
  const d = (dev||"").trim().toUpperCase();
  if (!d) throw new Error("ใส่ Device ก่อน (DEVxxxx)");
  return fetchJSON(`/api/device/config?device_id=${encodeURIComponent(d)}`);
}

async function saveDeviceConfig(dev, a1, a2, a3){
  const d = String(dev || "").trim().toUpperCase();
  if (!d) throw new Error("ใส่ Device ก่อน (DEVxxxx)");

  const r = await fetch("/api/device/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: d, a1, a2, a3 })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}


async function saveDeviceConfigAll(a1, a2, a3){
  const r = await fetch("/api/device/config/apply-all", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ a1, a2, a3 })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

function setCfgBusy(b){
  for (const id of ["btnCfgLoad","btnCfgSave","btnCfgSaveAll","cfgDev","cfgA1","cfgA2","cfgA3"]) {
    const el = $(id);
    if (!el) continue;
    el.disabled = !!b;
    el.style.opacity = b ? "0.7" : "1";
    el.style.pointerEvents = b ? "none" : "auto";
  }
}

async function doLoad(){
  const dev = ($("cfgDev").value || "").trim().toUpperCase();
  setCfgBusy(true);
  try{
    const cfg = await fetchDeviceConfig(dev);
    if (!cfg) { toast("No data", "ยังไม่มี config"); return; }
    $("cfgDev").value = cfg.device_id || dev;
    $("cfgA1").value = cfg.a1;
    $("cfgA2").value = cfg.a2;
    $("cfgA3").value = cfg.a3;
    toast("Loaded", `${cfg.device_id}: ${cfg.a1}/${cfg.a2}/${cfg.a3}`);

    // remember device
    localStorage.setItem("deviceId", (cfg.device_id || dev));

    // refresh dependent widgets
    previewImage().catch(()=>{});
    refreshGps(true).catch(()=>{});

  }finally{
    setCfgBusy(false);
  }
}

async function doSave(){
  const dev = ($("cfgDev").value || "").trim().toUpperCase();
  const a1 = parsePosInt($("cfgA1").value);
  const a2 = parsePosInt($("cfgA2").value);
  const a3 = parsePosInt($("cfgA3").value);

  if (!dev) throw new Error("ใส่ Device ก่อน (DEVxxxx)");
  if (!a1 || !a2 || !a3) throw new Error("A1/A2/A3 ต้องเป็นตัวเลข > 0");

  setCfgBusy(true);
  try{
    const r = await saveDeviceConfig(dev, a1, a2, a3);
    toast("Saved", `${r.device_id}: ${r.a1}/${r.a2}/${r.a3}`);
    localStorage.setItem("deviceId", r.device_id);
  }finally{
    setCfgBusy(false);
  }
}


async function doSaveAll(){
  const a1 = parsePosInt($("cfgA1").value);
  const a2 = parsePosInt($("cfgA2").value);
  const a3 = parsePosInt($("cfgA3").value);

  if (!a1 || !a2 || !a3) throw new Error("A1/A2/A3 ต้องเป็นตัวเลข > 0");

  setCfgBusy(true);
  try{
    const r = await saveDeviceConfigAll(a1, a2, a3);
    toast("Saved ALL", `Updated ${r.devices_updated || 0} devices • default=ALL`);
  }finally{
    setCfgBusy(false);
  }
}

/* =====================================================================================
   2) Image Upload (Splash/Background)
===================================================================================== */
function imgFilenameFor(dev){
  const d = String(dev || "").trim().toUpperCase();
  if (!d || d === "ALL") return "splash.jpg";
  return `splash_${d}.jpg`;
}

function getImageTargetDevice(){
  const tgt = String($("imgTarget")?.value || "ALL").toUpperCase();
  if (tgt === "ALL") return "ALL";
  const dev = ($("cfgDev")?.value || "").trim().toUpperCase();
  if (!dev) throw new Error("ใส่ Device ก่อน หรือเลือก ALL");
  return dev;
}

async function resolveImageUrl(dev){
  const d = String(dev || "").trim().toUpperCase();
  if (!d || d === "ALL") return "/images/splash.jpg";
  try{
    const j = await fetchJSON(`/api/images/resolve?device_id=${encodeURIComponent(d)}`);
    if (j?.ok && j?.url) return j.url;
  }catch{}
  return `/images/${imgFilenameFor(d)}`;
}

function setImgBusy(b){
  for (const id of ["btnImgUpload","btnImgPreview","imgTarget","imgFile"]) {
    const el = $(id);
    if (!el) continue;
    el.disabled = !!b;
    el.style.opacity = b ? "0.7" : "1";
    el.style.pointerEvents = b ? "none" : "auto";
  }
}

async function previewImage(){
  const info = $("imgInfo");
  const img = $("imgPreview");
  const openBtn = $("btnImgOpen");
  if (!img) return;

  try{
    const dev = getImageTargetDevice();
    const url = await resolveImageUrl(dev);
    const bust = (url.includes("?") ? "&" : "?") + "t=" + Date.now();
    img.src = url + bust;
    if (openBtn) openBtn.href = url;
    if (info) info.textContent = `${imgFilenameFor(dev)} • ${dev}`;
  }catch(e){
    if (info) info.textContent = e.message || String(e);
  }
}

async function doImgUpload(){
  const f = $("imgFile")?.files?.[0];
  if (!f) throw new Error("เลือกไฟล์ .jpg ก่อน");
  if (!String(f.type || "").includes("jpeg") && !String(f.name || "").toLowerCase().match(/\.(jpg|jpeg)$/)) {
    throw new Error("รองรับเฉพาะไฟล์ .jpg/.jpeg");
  }

  const dev = getImageTargetDevice();

  // NOTE: ใส่ device_id ก่อน แล้วค่อยใส่ไฟล์ เพื่อให้ multer อ่าน req.body ได้ใน filename()
  const fd = new FormData();
  fd.append("device_id", dev);
  fd.append("image", f, f.name || "splash.jpg");

  setImgBusy(true);
  try{
    const r = await fetch("/api/images/upload", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);

    const kb = Math.round(Number(j.size || 0) / 1024);
    toast("Image uploaded", `${j.filename} (${kb} KB)`);

    // refresh preview
    const url = j.url || ("/images/" + j.filename);
    const img = $("imgPreview");
    const info = $("imgInfo");
    const openBtn = $("btnImgOpen");
    if (img) img.src = url + "?t=" + Date.now();
    if (openBtn) openBtn.href = url;
    if (info) info.textContent = `${j.filename} • ${kb} KB • ${j.device_id || dev}`;
  }finally{
    setImgBusy(false);
  }
}

/* =====================================================================================
   3) GPS Status (latest per device)
===================================================================================== */
let lastGpsFetch = 0;
const GPS_FETCH_MIN_MS = 1500;

async function fetchLatestLocation(dev){
  const d = String(dev || "").trim().toUpperCase();
  if (!d) throw new Error("ใส่ Device ก่อน (DEVxxxx)");
  const j = await fetchJSON(`/api/dashboard/locations?device_id=${encodeURIComponent(d)}`);
  const rows = j?.rows || [];
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function gpsStatusHtml(dev, row){
  const d = String(dev || "").trim().toUpperCase();
  if (!row){
    return `
      <div><b>${escapeHtml(d)}</b></div>
      <div style="margin-top:6px">ยังไม่มีข้อมูล GPS</div>
      <div style="margin-top:6px; opacity:.9">• บอร์ดต้อง POST <code>/api/device/location</code> ก่อน</div>
    `;
  }

  const name = row.device_name || d;
  const fix = Number(row.fix) ? 1 : 0;
  const fixBadge = fix
    ? `<span class="badge stPaid"><span class="badgeDot"></span>FIX</span>`
    : `<span class="badge stExpired"><span class="badgeDot"></span>NO FIX</span>`;

  const updated = row.updated_at ? Number(row.updated_at) : 0;
  const ageMs = updated ? (Date.now() - updated) : 0;
  const stale = updated && ageMs > 5 * 60 * 1000;
  const staleTxt = stale ? ` <span class="badge stPending" title="ข้อมูลเก่า"><span class="badgeDot"></span>STALE</span>` : "";

  // NOTE: Number(null) === 0, which incorrectly shows "0,0" when the server stores NULL.
  // Treat null/undefined as missing coordinates.
  const lat = (row.lat === null || row.lat === undefined) ? NaN : Number(row.lat);
  const lon = (row.lon === null || row.lon === undefined) ? NaN : Number(row.lon);
  const pos = fmtLatLon(lat, lon);

  const extra = [];
  if (Number.isFinite(Number(row.hdop))) extra.push(`HDOP ${Number(row.hdop).toFixed(1)}`);
  if (Number.isFinite(Number(row.gps_svs))) extra.push(`GPS SV ${Number(row.gps_svs)}`);

  const mapUrl = (Number.isFinite(lat) && Number.isFinite(lon))
    ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}`
    : "";

  return `
    <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
      <div style="font-weight:800">${escapeHtml(name)}</div>
      <div>${fixBadge}${staleTxt}</div>
    </div>
    <div style="margin-top:6px">Updated: <b>${escapeHtml(updated ? toThaiDateTime(updated) : "-")}</b></div>
    <div style="margin-top:6px">Lat/Lon: <code>${escapeHtml(pos)}</code>
      ${mapUrl ? `<a class="btn btnGhost btnNav" style="height:30px; padding:0 10px; margin-left:8px;" href="${mapUrl}" target="_blank" rel="noreferrer">Open Map</a>` : ""}
    </div>
    ${extra.length ? `<div style="margin-top:6px; opacity:.9">${escapeHtml(extra.join(" • "))}</div>` : ""}
  `;
}

async function refreshGps(force=false){
  const now = Date.now();
  if (!force && (now - lastGpsFetch) < GPS_FETCH_MIN_MS) return;
  lastGpsFetch = now;

  const box = $("gpsStatusBox");
  if (!box) return;

  const dev = ($("cfgDev")?.value || "").trim().toUpperCase();
  if (!dev){
    box.innerHTML = `<div>ใส่ Device ก่อน (DEVxxxx)</div>`;
    return;
  }
  if (dev === "ALL"){
    box.innerHTML = `<div>โหมด ALL ดูได้เฉพาะแผนที่รวม — ไปที่ <a href="/dashboard.html#gps">Dashboard → GPS Map</a></div>`;
    return;
  }

  box.textContent = "Loading…";
  try{
    const row = await fetchLatestLocation(dev);
    box.innerHTML = gpsStatusHtml(dev, row);

    const hint = $("hint");
    if (hint){
      const parts = [];

      const updated = row?.updated_at ? Number(row.updated_at) : 0;
      const ageMs = updated ? (Date.now() - updated) : 1e12;
      const online = updated && ageMs < 10 * 60 * 1000;

      parts.push(badgeHtml(online ? "stOnline" : "stOffline", online ? "ONLINE" : "OFFLINE"));

      const fix = Number(row?.fix) ? 1 : 0;
      parts.push(badgeHtml(fix ? "stFix" : "stNoFix", fix ? "FIX" : "NO FIX"));

      parts.push(`<span class="muted">GPS ${escapeHtml(updated ? toThaiDateTime(updated) : "no data")}</span>`);

      const lat = (row?.lat === null || row?.lat === undefined) ? NaN : Number(row?.lat);
      const lon = (row?.lon === null || row?.lon === undefined) ? NaN : Number(row?.lon);
      const pos = fmtLatLonShort(lat, lon);
      if (pos) parts.push(`<span class="muted">📍 ${escapeHtml(pos)}</span>`);

      if (settingsState.otaVersion) parts.push(`<span class="muted">FW ${escapeHtml(settingsState.otaVersion)}</span>`);

      hint.innerHTML = parts.join(" ");
    }
  }catch(e){
    box.innerHTML = `<div>GPS Error: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

/* =====================================================================================
   4) OTA
===================================================================================== */
const settingsState = {
  otaVersion: "",
};

function isValidVersion(v){
  const s = String(v || "").trim();
  // 1.2.3 or 1.2.3-beta
  return /^[0-9]+\.[0-9]+\.[0-9]+([\-\.][0-9A-Za-z]+)*$/.test(s);
}

function isValidHHMM(s){
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || "").trim());
}

function fmtTzOffset(mins){
  const m = Number(mins);
  if (!Number.isFinite(m)) return "UTC";
  const sign = m >= 0 ? "+" : "-";
  const a = Math.abs(m);
  const hh = String(Math.floor(a / 60)).padStart(2, "0");
  const mm = String(a % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

function setOtaBusy(b){
  for (const id of ["btnOtaUpload","btnSaveSchedule","otaVersion","otaFile","applyTime"]) {
    const el = $(id);
    if (!el) continue;
    el.disabled = !!b;
    el.style.opacity = b ? "0.7" : "1";
    el.style.pointerEvents = b ? "none" : "auto";
  }
}

async function loadCurrent(){
  try{
    // meta=1 -> always return schedule + server time
    const m = await fetchJSON("/api/ota/manifest?version=0&meta=1");
    if (!m){
      $("curInfo").textContent = "No firmware.json";
      settingsState.otaVersion = "";
      return;
    }

    settingsState.otaVersion = String(m.version || "");

    $("curInfo").innerHTML = `Current: <b>${escapeHtml(m.version || "-")}</b> • url: <code>${escapeHtml(m.url || "-")}</code>`;

    if (m.version && !$("otaVersion").value) $("otaVersion").value = String(m.version);

    // schedule
    const at = String(m.apply_time || "00:00");
    const tz = Number(m.tz_offset_min);
    const applyTimeInput = $("applyTime");
    if (applyTimeInput) applyTimeInput.value = isValidHHMM(at) ? at : "00:00";

    const schedInfo = $("schedInfo");
    if (schedInfo){
      schedInfo.innerHTML = `Apply after <b>${escapeHtml(isValidHHMM(at) ? at : "00:00")}</b> (${escapeHtml(fmtTzOffset(tz))})`;
    }

    // update combined hint
    const hint = $("hint");
    if (hint){
      const dev = ($("cfgDev")?.value || "").trim().toUpperCase();
      const parts = [];
      if (dev) parts.push(`DEV: ${dev}`);
      if (settingsState.otaVersion) parts.push(`FW: ${settingsState.otaVersion}`);
      hint.innerHTML = parts.join(" ");
    }

  }catch(e){
    $("curInfo").textContent = "Failed to load manifest";
    settingsState.otaVersion = "";
  }
}

async function saveSchedule(){
  const t = String($("applyTime")?.value || "").trim();
  if (!isValidHHMM(t)) throw new Error('Time must be HH:MM');

  setOtaBusy(true);
  try{
    const r = await fetch("/api/ota/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apply_time: t })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);

    toast("Schedule saved", `Apply after ${j.apply_time}`);
    await loadCurrent();
  }finally{
    setOtaBusy(false);
  }
}

async function doUpload(){
  const version = ($("otaVersion").value || "").trim();
  const f = $("otaFile").files?.[0];

  if (!version) throw new Error("Enter version first");
  if (!isValidVersion(version)) throw new Error("Invalid version (example 1.6.10)");
  if (!f) throw new Error("Select a .bin file");

  const fd = new FormData();
  fd.append("version", version);
  fd.append("firmware", f, "firmware.bin");

  setOtaBusy(true);
  try{
    const r = await fetch("/api/ota/upload", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);

    toast("Upload OK", `version ${j.version} (${Math.round((j.size||0)/1024)} KB)`);
    await loadCurrent();
  }finally{
    setOtaBusy(false);
  }
}

/* ===== Reveal-on-scroll (slide) ===== */
function initReveal(){
  const els = document.querySelectorAll(".card, .tableWrap, .chartDrawer, .mapCard");
  if (!els.length) return;

  const io = new IntersectionObserver((entries)=>{
    for (const e of entries){
      if (e.isIntersecting){
        e.target.classList.add("isIn");
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.12 });

  for (const el of els){
    el.classList.add("reveal");
    io.observe(el);
  }
}

/* =====================================================================================
   Init
===================================================================================== */
(function init(){
  setTheme(localStorage.getItem("theme") || "dark");
  $("btnTheme")?.addEventListener("click", toggleTheme);

  // preload device
  const pre = getQueryDevice() || (localStorage.getItem("deviceId") || "");
  if (pre && pre !== "ALL") $("cfgDev").value = pre.toUpperCase();

  $("btnCfgLoad")?.addEventListener("click", ()=>doLoad().catch(e=>toast("Load failed", e.message||String(e))));
  $("btnCfgSave")?.addEventListener("click", ()=>doSave().catch(e=>toast("Save failed", e.message||String(e))));
  $("btnCfgSaveAll")?.addEventListener("click", ()=>doSaveAll().catch(e=>toast("Save ALL failed", e.message||String(e))));

  // Image upload
  $("btnImgUpload")?.addEventListener("click", ()=>doImgUpload().catch(e=>toast("Upload failed", e.message||String(e))));
  $("btnImgPreview")?.addEventListener("click", ()=>previewImage().catch(()=>{}));
  $("imgTarget")?.addEventListener("change", ()=>previewImage().catch(()=>{}));
  $("imgFile")?.addEventListener("change", ()=>{
    const f = $("imgFile")?.files?.[0];
    const info = $("imgInfo");
    if (info && f) info.textContent = `Selected: ${f.name} • ${Math.round((f.size||0)/1024)} KB`;
  });

  // When typing device id -> preview + gps debounce
  $("cfgDev")?.addEventListener("input", ()=>{
    if ((String($("imgTarget")?.value || "ALL").toUpperCase()) === "DEVICE") previewImage().catch(()=>{});

    clearTimeout(window._gpsDeb);
    window._gpsDeb = setTimeout(()=>refreshGps(false).catch(()=>{}), 450);

    const hint = $("hint");
    if (hint){
      const dev = ($("cfgDev")?.value || "").trim().toUpperCase();
      const parts = [];
      if (dev) parts.push(`DEV: ${dev}`);
      if (settingsState.otaVersion) parts.push(`FW: ${settingsState.otaVersion}`);
      hint.innerHTML = parts.join(" ");
    }
  });

  // default target
  if (($("cfgDev")?.value || "").trim()) {
    const sel = $("imgTarget");
    if (sel) sel.value = "DEVICE";
  }

  // GPS
  $("btnGpsRefresh")?.addEventListener("click", ()=>refreshGps(true).catch(()=>{}));

  // OTA
  $("btnOtaUpload")?.addEventListener("click", ()=>doUpload().catch(e=>toast("Upload failed", e.message||String(e))));
  $("btnSaveSchedule")?.addEventListener("click", ()=>saveSchedule().catch(e=>toast("Save failed", e.message||String(e))));

  // initial load
  loadCurrent().catch(()=>{});
  previewImage().catch(()=>{});
  refreshGps(true).catch(()=>{});

  // Auto load config when device prefilled (optional)
  if (($("cfgDev").value || "").trim()) {
    doLoad().catch(()=>{});
  }
})();
