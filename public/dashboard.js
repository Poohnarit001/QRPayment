"use strict";

const $ = (id) => document.getElementById(id);

const PAGE_SIZE = 10;
const MAX_FETCH = 600;

/* ===== Device colors (unique per device in current view) =====
   - Goal: each device shows a different color (no duplicates) on the GPS map + list.
   - Uses deterministic hash from device_id; if collision occurs, it shifts hue by golden-angle until unique.
*/
function hash32(str){
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const GOLDEN_ANGLE = 137.508;

function buildUniqueDeviceColors(rows){
  const used = new Set();
  const colors = {};
  for (const r of (rows || [])){
    const id = String((r && (r.device_id || r.device_name)) || "").trim();
    if (!id || colors[id]) continue;

    const base = hash32(id) % 360;

    let chosen = null;
    for (let i = 0; i < 360; i++){
      const hue = (base + i * GOLDEN_ANGLE) % 360;
      const col = `hsl(${Math.round(hue)}, 85%, 55%)`;
      if (!used.has(col)){
        chosen = col;
        used.add(col);
        break;
      }
    }
    colors[id] = chosen || `hsl(${Math.round(base)}, 85%, 55%)`;
  }
  return colors;
}


// Month names (English)
const MONTHS = [
  { v: 1,  name: "January" },
  { v: 2,  name: "February" },
  { v: 3,  name: "March" },
  { v: 4,  name: "April" },
  { v: 5,  name: "May" },
  { v: 6,  name: "June" },
  { v: 7,  name: "July" },
  { v: 8,  name: "August" },
  { v: 9,  name: "September" },
  { v: 10, name: "October" },
  { v: 11, name: "November" },
  { v: 12, name: "December" },
];

let state = {
  deviceId: "ALL",
  refreshMs: 2000,

  // Dropdown filters ("" = All)
  year: "",
  month: "",
  day: "",

  search: "",
  page: 1,

  allRows: [],
  filteredRows: [],
};

/* ===== Time format (dd/mm + Buddhist year) ===== */
function pad2(n){ return String(n).padStart(2,"0"); }
function toThaiDateTime(ts){
  const d = new Date(ts || Date.now());
  const dd = pad2(d.getDate());
  const mm = pad2(d.getMonth()+1);
  const yyyy = d.getFullYear() + 543; // Buddhist Era
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
}
function fmtMoney(n){
  const v = Number(n||0);
  return "฿ " + v.toLocaleString("th-TH");
}
function fmtNum(n){ return Number(n||0).toLocaleString("th-TH"); }
function fmtTime(ts){ return ts ? toThaiDateTime(ts) : "-"; }

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
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


/* ===== API ===== */
async function fetchJSON(url){
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function fetchTransactions(deviceId, limit){
  const q = deviceId ? `device_id=${encodeURIComponent(deviceId)}` : "";
  const url1 = `/api/dashboard/transactions?${q}${q ? "&" : ""}limit=${limit}`;
  const url2 = `/transactions?${q}${q ? "&" : ""}limit=${limit}`;
  try { return await fetchJSON(url1); } catch { return await fetchJSON(url2); }
}

async function fetchSummary(deviceId){
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  const url1 = `/api/dashboard/summary${q}`;
  const url2 = `/summary${q}`;
  try { return await fetchJSON(url1); } catch { return await fetchJSON(url2); }
}



async function fetchLocations(deviceId){
  const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
  return fetchJSON(`/api/dashboard/locations${q}`);
}

/* ===== GPS Map (Leaflet) ===== */
let locMap = null;
let locLayer = null;
let locMarkers = new Map();
let lastLocFetch = 0;
const LOC_FETCH_MIN_MS = 10000;

function initLocMapOnce(){
  const el = $("map");
  if (!el || !window.L) return;
  if (locMap) return;

  // Default view: Thailand
  locMap = L.map(el, { zoomControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(locMap);

  locLayer = L.layerGroup().addTo(locMap);
  locMap.setView([13.7563, 100.5018], 6);
}

function locPopupHtml(r){
  const name = r.device_name || r.device_id || "DEVICE";
  const fixTxt = r.fix ? "FIX" : "NO FIX";
  const t = r.updated_at ? toThaiDateTime(r.updated_at) : "-";
  // NOTE: Number(null) === 0, which incorrectly shows "0,0" when the server stores NULL.
  // Treat null/undefined as missing coordinates.
  const lat = (r.lat === null || r.lat === undefined) ? NaN : Number(r.lat);
  const lon = (r.lon === null || r.lon === undefined) ? NaN : Number(r.lon);
  const pos = (Number.isFinite(lat) && Number.isFinite(lon)) ? `${lat.toFixed(6)}, ${lon.toFixed(6)}` : "-";

  const extra = [];
  if (Number.isFinite(Number(r.hdop))) extra.push(`HDOP ${Number(r.hdop).toFixed(1)}`);
  if (Number.isFinite(Number(r.gps_svs))) extra.push(`GPS SV ${Number(r.gps_svs)}`);

  return `
    <div style="min-width:220px">
      <div style="font-weight:700">${escapeHtml(name)}</div>
      <div style="margin-top:4px">${escapeHtml(fixTxt)} • ${escapeHtml(t)}</div>
      <div style="margin-top:6px"><code>${escapeHtml(pos)}</code></div>
      ${extra.length ? `<div style="margin-top:6px; opacity:.8">${escapeHtml(extra.join(" • "))}</div>` : ""}
    </div>
  `;
}

function renderLocList(rows, colors){
  const box = $("locList");
  if (!box) return;

  if (!rows || !rows.length){
    box.innerHTML = `<div class="muted small">No GPS data yet.</div>`;
    return;
  }

  box.innerHTML = rows.map(r => {
    const id = r.device_id || "";
    const name = r.device_name || id;
    const t = r.updated_at ? toThaiDateTime(r.updated_at) : "-";
    const fix = r.fix ? 1 : 0;
    const cls = fix ? "locChip" : "locChip noFix";

    const key = String((r.device_id || r.device_name) || "").trim();
    const col = (colors && colors[key]) ? colors[key] : "hsl(0,0%,70%)";
    const dotStyle = `background:${col};opacity:${fix ? 1 : 0.35};`;

    return `
      <div class="${cls}" data-dev="${escapeHtml(id)}" title="Click to focus">
        <span class="locDot" style="${dotStyle}"></span>
        <div>
          <div style="font-weight:700">${escapeHtml(name)}</div>
          <div class="locMeta">${escapeHtml(t)}</div>
        </div>
      </div>
    `;
  }).join("");
}

function updateLocMap(rows){
  initLocMapOnce();
  if (!locMap || !locLayer) return;

  locLayer.clearLayers();
  locMarkers.clear();

  const colors = buildUniqueDeviceColors(rows || []);

  const bounds = [];
  for (const r of (rows || [])){
    const lat = (r.lat === null || r.lat === undefined) ? NaN : Number(r.lat);
    const lon = (r.lon === null || r.lon === undefined) ? NaN : Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const key = String((r.device_id || r.device_name) || "").trim();
    const col = colors[key] || "hsl(0,0%,70%)";

    const opts = {
      radius: 9,
      color: col,
      weight: 3,
      fillColor: col,
      fillOpacity: r.fix ? 0.85 : 0.25,
    };
    if (!r.fix) opts.dashArray = "4 6";

    const marker = L.circleMarker([lat, lon], opts).addTo(locLayer);
    marker.bindPopup(locPopupHtml(r));

    if (r.device_id) locMarkers.set(String(r.device_id), marker);
    bounds.push([lat, lon]);
  }

  renderLocList(rows || [], colors);

  if (bounds.length){
    try{ locMap.fitBounds(bounds, { padding: [22,22], maxZoom: 15 }); }catch{}
  }
}

async function refreshLocations(force=false){
  const now = Date.now();
  if (!force && now - lastLocFetch < LOC_FETCH_MIN_MS) return;
  lastLocFetch = now;

  const status = $("locStatus");
  if (status) status.textContent = "Loading…";

  try{
    const dev = state.deviceId && state.deviceId.toUpperCase() !== "ALL" ? state.deviceId : "";
    const data = await fetchLocations(dev);
    const rows = data.rows || [];

    updateLocMap(Array.isArray(rows) ? rows : []);
    if (status) status.textContent = "Updated: " + toThaiDateTime(data.updated_at || Date.now());
  }catch(e){
    console.error(e);
    if (status) status.textContent = "GPS API not available";
  }
}

// click chips to focus marker
$("locList")?.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-dev]");
  if (!el) return;
  const id = el.getAttribute("data-dev") || "";
  const mk = locMarkers.get(id);
  if (mk && locMap){
    try{ locMap.setView(mk.getLatLng(), Math.max(15, locMap.getZoom())); }catch{}
    try{ mk.openPopup(); }catch{}
  }
});

$("btnLocRefresh")?.addEventListener("click", () => refreshLocations(true));

// NOTE: Device config editor moved to /config.html (see config.js)

/* ===== Data helpers ===== */
function rowTimeMs(row){
  if (row.paid_at){
    const t = Date.parse(row.paid_at);
    if (!Number.isNaN(t)) return t;
  }
  return Number(row.updated_at || 0);
}

function normalizeStatus(st){
  const s = String(st || "UNKNOWN").toUpperCase();
  if (s === "SETTLED") return "PAID";
  if (s === "CANCELED") return "CANCELLED";
  if (s === "EXPIRED") return "CANCELLED";
  return s;
}

function setBusy(b){
  const btn = $("btnApply");
  btn.disabled = b;
  btn.style.opacity = b ? "0.7" : "1";
  btn.style.pointerEvents = b ? "none" : "auto";
}

/**
 * Logic:
 * - ปี=ทั้งหมด => ไม่กรองปี
 * - เดือน=ทั้งหมด => ไม่กรองเดือน
 * - วัน=ทั้งหมด => ไม่กรองวัน
 * - วันจะมีผลก็ต่อเมื่อเลือก "เดือน" แล้ว
 */
function inRangeBySelection(row){
  const t = rowTimeMs(row);
  if (!t) return false;
  const d = new Date(t);

  const Y = d.getFullYear();
  const M = d.getMonth() + 1;
  const D = d.getDate();

  const ySel = state.year ? Number(state.year) : 0;
  const mSel = state.month ? Number(state.month) : 0;
  const dSel = state.day ? Number(state.day) : 0;

  if (ySel && Y !== ySel) return false;
  if (mSel && M !== mSel) return false;
  if (dSel && mSel && D !== dSel) return false;

  return true;
}

function monthNameShort(m){
  const mm = Number(m||0);
  const n = MONTHS.find(x=> x.v === mm)?.name || String(mm);
  return String(n).slice(0,3);
}

function rangeHintText(){
  const dev = state.deviceId || "ALL";
  const y = state.year || "All years";
  const m = state.month ? monthNameShort(state.month) : "All months";
  const d = state.day ? String(state.day) : "All days";

  if (state.month && state.day) return `${y}-${pad2(state.month)}-${pad2(state.day)} • ${dev}`;
  if (state.month) return `${m} ${state.year || ""}`.trim() + ` • ${dev}`;
  if (state.year)  return `${state.year} • ${dev}`;
  return `All years • ${dev}`;
}

/* ===== Status badge ===== */
function statusClass(st){
  const s = normalizeStatus(st);
  if (s === "PAID") return "stPaid";
  if (s === "PENDING") return "stPending";
  if (s === "EXPIRED") return "stExpired";
  if (s === "CANCELLED") return "stCancelled";
  if (s === "FAILED") return "stFailed";
  return "stUnknown";
}

function statusBadge(stRaw){
  const st = normalizeStatus(stRaw);
  const cls = statusClass(st);
  return `<span class="badge ${cls}"><span class="badgeDot"></span>${st}</span>`;
}

/* ===== Cells ===== */
function invoiceCell(row){
  const id = row.invoice_id || "-";
  const url = row.invoice_url || "";
  if (url){
    return `<a class="invLink" href="${url}" target="_blank" rel="noreferrer"><code>${id}</code></a>`;
  }
  return `<code>${id}</code>`;
}

/* ===== Render ===== */
function renderKPI(rows){
  const paid = rows.filter(r => normalizeStatus(r.status) === "PAID");
  const totalPaid = paid.reduce((s,r)=> s + Number(r.amount||0), 0);

  $("totalPaid").textContent  = fmtMoney(totalPaid);
  $("countPaid").textContent  = fmtNum(paid.length);
  $("countAll").textContent   = fmtNum(rows.length);
  $("rangeHint").textContent  = rangeHintText();
}

function applyFilters(){
  let rows = state.allRows.filter(inRangeBySelection);

  const q = (state.search || "").trim().toLowerCase();
  if (q){
    rows = rows.filter(r => {
      const txt = `${r.invoice_id||""} ${r.device_id||""} ${r.status||""} ${r.amount||""} ${r.external_id||""}`.toLowerCase();
      return txt.includes(q);
    });
  }

  rows.sort((a,b)=> rowTimeMs(b) - rowTimeMs(a));
  state.filteredRows = rows;

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.page = Math.min(Math.max(1, state.page), totalPages);

  renderKPI(rows);
  renderTable();
  // ถ้ากราฟเปิดอยู่ ให้รีเฟรชตามตัวกรองเดียวกัน
  try { updateChartIfOpen?.(); } catch {}
}

function renderTable(){
  const tbody = $("tbody");
  tbody.innerHTML = "";

  const rows = state.filteredRows;
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const start = (state.page - 1) * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, total);
  const pageRows = rows.slice(start, end);

  if (!total){
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="padding:18px 10px; color: var(--muted);">
          No data in the selected range
        </td>
      </tr>
    `;
    $("pagerInfo").textContent = `0 items`;
    $("pageNow").textContent = "1";
    $("pageTotal").textContent = "1";
    $("btnPrev").disabled = true;
    $("btnNext").disabled = true;
    return;
  }

  for (const row of pageRows){
    const tr = document.createElement("tr");
    const tms = rowTimeMs(row);
    tr.innerHTML = `
      <td>${fmtTime(tms)}</td>
      <td>${invoiceCell(row)}</td>
      <td>${row.device_id || "-"}</td>
      <td>${fmtNum(row.amount)}</td>
      <td>${statusBadge(row.status)}</td>
      <td style="text-align:right;">
        <button class="copyBtn" data-copy="${row.invoice_id || ""}" title="Copy Invoice ID">⎘</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  $("pagerInfo").textContent = `Showing ${start+1}-${end} of ${total} items (page size ${PAGE_SIZE})`;
  $("pageNow").textContent = String(state.page);
  $("pageTotal").textContent = String(totalPages);
  $("btnPrev").disabled = state.page <= 1;
  $("btnNext").disabled = state.page >= totalPages;
}

/* ===== Dropdown options ===== */
function buildYearOptions(rows){
  const years = new Set();
  rows.forEach(r=>{
    const t = rowTimeMs(r);
    if (!t) return;
    years.add(new Date(t).getFullYear());
  });
  const list = Array.from(years).sort((a,b)=> b-a);

  const sel = $("pickYear");
  sel.innerHTML = "";

  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "All";
  sel.appendChild(optAll);

  for (const y of (list.length ? list : [new Date().getFullYear()])){
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  }
  sel.value = state.year || "";
}

function buildMonthOptions(){
  const sel = $("pickMonth");
  sel.innerHTML = "";

  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "All";
  sel.appendChild(optAll);

  for (const m of MONTHS){
    const opt = document.createElement("option");
    opt.value = String(m.v);
    opt.textContent = m.name;
    sel.appendChild(opt);
  }
  sel.value = state.month || "";
}

function daysInMonthSmart(year, month){
  const y = year ? Number(year) : 2024; // กัน Feb หาย
  return new Date(y, Number(month), 0).getDate();
}

function buildDayOptions(){
  const sel = $("pickDay");
  sel.innerHTML = "";

  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "All";
  sel.appendChild(optAll);

  if (!state.month){
    sel.value = "";
    return;
  }

  const maxD = daysInMonthSmart(state.year, state.month);
  for (let d=1; d<=maxD; d++){
    const opt = document.createElement("option");
    opt.value = String(d);
    opt.textContent = String(d);
    sel.appendChild(opt);
  }

  // clamp
  if (state.day){
    let dd = Number(state.day);
    if (dd < 1) dd = 1;
    if (dd > maxD) dd = maxD;
    state.day = String(dd);
  }

  sel.value = state.day || "";
}

/* ===== Refresh loop ===== */
async function refresh(){
  setBusy(true);
  try{
    const deviceForApi = state.deviceId && state.deviceId.toUpperCase() !== "ALL" ? state.deviceId : "";

    const sum = await fetchSummary(deviceForApi);
    $("lastUpdate").textContent = "Last update: " + toThaiDateTime(sum.updated_at || Date.now());

    const tx = await fetchTransactions(deviceForApi, MAX_FETCH);
    const rows = tx.rows || tx.data || tx || [];
    state.allRows = Array.isArray(rows) ? rows : [];

    buildYearOptions(state.allRows);
    buildMonthOptions();
    buildDayOptions();

    $("rangeHint").textContent = rangeHintText();
    applyFilters();

    // GPS map (throttled)
    refreshLocations().catch(()=>{});
  }catch(e){
    console.error(e);
    toast("Load failed", String(e.message || e));
  }finally{
    setBusy(false);
  }
}

let timer = null;
function startTimer(){
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, state.refreshMs);
}

function persist(){
  localStorage.setItem("deviceId", state.deviceId);
  localStorage.setItem("refreshMs", String(state.refreshMs));
  localStorage.setItem("year", state.year);
  localStorage.setItem("month", state.month);
  localStorage.setItem("day", state.day);
}

function applyDeviceAndRefresh(){
  let d = ($("deviceId").value || "").trim();
  if (!d || d.toUpperCase() === "ALL") d = "ALL";
  state.deviceId = d;

  state.refreshMs = Number($("refreshMs").value || 2000);
  state.page = 1;

  persist();
  refresh().then(startTimer);
}

/* ===== Theme ===== */
function setTheme(theme){
  const root = document.documentElement;
  root.classList.add("theme-switching");

  // Apply immediately (faster than ViewTransition on low-end devices)
  root.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  const icon = $("themeIcon");
  if (icon) icon.textContent = theme === "dark" ? "☾" : "☀";

  clearTimeout(setTheme._tm);
  setTheme._tm = setTimeout(() => root.classList.remove("theme-switching"), 200);
}

function toggleTheme(){
  const root = document.documentElement;
  const cur = root.getAttribute("data-theme") || "dark";
  setTheme(cur === "dark" ? "light" : "dark");
  // ให้กราฟเปลี่ยนสีตามธีมด้วย
  try { updateChartIfOpen?.(); } catch {}
}


function setToday(){
  const now = new Date();
  state.year = String(now.getFullYear());
  state.month = String(now.getMonth()+1);
  state.day = String(now.getDate());

  $("pickYear").value = state.year;
  $("pickMonth").value = state.month;
  buildDayOptions();
  $("pickDay").value = state.day;

  state.page = 1;
  applyFilters();
  persist();
}

/* ===== CSV Export ===== */
function escapeCsv(v){
  const s = String(v ?? "");
  // ถ้ามี comma/quote/newline ต้องครอบด้วย " และ escape "
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows){
  // ใส่ BOM ให้ Excel ไทยเปิดไม่เพี้ยน
  const bom = "\uFEFF";

  const headers = [
    "datetime",
    "invoice_id",
    "device_id",
    "amount",
    "status",
    "invoice_url"
  ];

  const lines = [];
  lines.push(headers.join(","));

  for (const r of rows){
    const t = rowTimeMs(r);
    const line = [
      escapeCsv(fmtTime(t)),
      escapeCsv(r.invoice_id || ""),
      escapeCsv(r.device_id || ""),
      escapeCsv(Number(r.amount || 0)),
      escapeCsv(normalizeStatus(r.status)),
      escapeCsv(r.invoice_url || "")
    ].join(",");
    lines.push(line);
  }

  return bom + lines.join("\n");
}

function downloadCsv(filename, csvText){
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function filterRowsForMonthExport(){
  // ใช้ปี/เดือนที่เลือก ถ้าไม่เลือก -> ใช้เดือนปัจจุบัน
  const now = new Date();
  const year = state.year ? Number(state.year) : now.getFullYear();
  const month = state.month ? Number(state.month) : (now.getMonth() + 1);

  const rows = state.allRows.filter(r => {
    const t = rowTimeMs(r);
    if (!t) return false;
    const d = new Date(t);
    return d.getFullYear() === year && (d.getMonth()+1) === month;
  });

  rows.sort((a,b)=> rowTimeMs(b) - rowTimeMs(a));
  return { year, month, rows };
}

function filterRowsForYearExport(){
  // ใช้ปีที่เลือก ถ้าไม่เลือก -> ใช้ปีปัจจุบัน
  const now = new Date();
  const year = state.year ? Number(state.year) : now.getFullYear();

  const rows = state.allRows.filter(r => {
    const t = rowTimeMs(r);
    if (!t) return false;
    const d = new Date(t);
    return d.getFullYear() === year;
  });

  rows.sort((a,b)=> rowTimeMs(b) - rowTimeMs(a));
  return { year, rows };
}

$("btnCsvMonth")?.addEventListener("click", () => {
  const { year, month, rows } = filterRowsForMonthExport();
  if (!rows.length) return toast("No data", `No transactions in ${pad2(month)}/${year}`);

  const csv = rowsToCsv(rows);
  const filename = `transactions_${year}-${pad2(month)}.csv`;
  downloadCsv(filename, csv);
  toast("Export CSV", filename);
});

$("btnCsvYear")?.addEventListener("click", () => {
  const { year, rows } = filterRowsForYearExport();
  if (!rows.length) return toast("No data", `No transactions in ${year}`);

  const csv = rowsToCsv(rows);
  const filename = `transactions_${year}.csv`;
  downloadCsv(filename, csv);
  toast("Export CSV", filename);
});

/* ===== Events ===== */
$("btnApply").addEventListener("click", applyDeviceAndRefresh);
$("btnRefresh").addEventListener("click", () => refresh());
$("btnTheme").addEventListener("click", toggleTheme);

// Chart toggle (ถ้ามีปุ่ม/กล่องกราฟในหน้า)
$("btnChart")?.addEventListener("click", () => toggleChart());
$("chartClose")?.addEventListener("click", () => { if (chartOpen) toggleChart(); });
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && chartOpen) toggleChart();
});

$("refreshMs").addEventListener("change", () => {
  state.refreshMs = Number($("refreshMs").value || 2000);
  persist();
  startTimer();
});

$("search").addEventListener("input", () => {
  state.search = $("search").value || "";
  state.page = 1;
  applyFilters();
});

$("btnPrev").addEventListener("click", () => {
  state.page = Math.max(1, state.page - 1);
  renderTable();
});
$("btnNext").addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / PAGE_SIZE));
  state.page = Math.min(totalPages, state.page + 1);
  renderTable();
});

$("pickYear").addEventListener("change", () => {
  state.year = $("pickYear").value || "";
  buildDayOptions();
  state.page = 1;
  applyFilters();
  persist();
});

$("pickMonth").addEventListener("change", () => {
  state.month = $("pickMonth").value || "";
  if (!state.month) state.day = "";
  buildDayOptions();
  state.page = 1;
  applyFilters();
  persist();
});

$("pickDay").addEventListener("change", () => {
  if (!$("pickMonth").value) {
    $("pickDay").value = "";
    state.day = "";
  } else {
    state.day = $("pickDay").value || "";
  }
  state.page = 1;
  applyFilters();
  persist();
});

$("btnNow").addEventListener("click", setToday);

document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-copy]");
  if (!btn) return;
  const val = btn.getAttribute("data-copy") || "";
  if (!val) return;

  try{
    await navigator.clipboard.writeText(val);
    toast("Copied", val);
  }catch{
    const ta = document.createElement("textarea");
    ta.value = val;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("Copied", val);
  }
});


/* ===== Cumulative Chart (ยอดเงินสะสม) =====
   ตามที่ต้องการ:
   - เส้น/จุด = สีเขียว
   - สีใต้กราฟ = เขียวแบบ "ใส" กว่าเดิม
   - แบ่งข้อมูลเป็น "รายวัน" เมื่อเลือกปี+เดือน (แต่ไม่เลือกวัน)
   - แกน X แสดงเป็น "ช่วงๆ" ไม่แสดงทุกจุด
   - ถ้าเป็นมุมมองรายปี (เลือกปี แต่ไม่เลือกเดือน) ให้แสดงชื่อเดือนบนกราฟ
*/

let chartOpen = false;

const CHART_MONTHS_EN = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];

const CHART_MONTHS_SHORT = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec"
];

function toggleChart(){
  const drawer = $("chartDrawer");
  if (!drawer) return;

  chartOpen = !chartOpen;
  drawer.hidden = !chartOpen;

  const btn = $("btnChart");
  if (btn) btn.classList.toggle("isOn", chartOpen);

  if (chartOpen) renderChart();
}

function updateChartIfOpen(){
  if (chartOpen) renderChart();
}

function startOfDayMs(ms){
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function buildCumulativeSeries(){
  const rows = Array.isArray(state.filteredRows) ? state.filteredRows : [];
  const paidTx = rows
    .filter(r => normalizeStatus(r.status) === "PAID")
    .map(r => ({ t: rowTimeMs(r), a: Number(r.amount || 0) }))
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.a) && p.t > 0)
    .sort((x,y) => x.t - y.t);

  // View modes:
  // - Day selected: points by transaction time (HH:MM)
  // - Year+Month (no Day): aggregate daily (1 point/day)
  // - Year only: aggregate monthly (Jan..Dec)
  // - No Year: aggregate yearly (2025, 2026, ...)
  const hasY = !!state.year;
  const hasM = !!state.month;
  const hasD = !!state.day;

  let mode = "intraday";
  if (hasY && hasM && hasD) mode = "intraday";
  else if (hasY && hasM) mode = "daily";
  else if (hasY) mode = "monthly";
  else mode = "yearly";

  // Intraday: one point per transaction
  if (mode === "intraday"){
    let cum = 0;
    const points = paidTx.map(p => {
      cum += p.a;
      return { t: p.t, a: p.a, cum };
    });
    return { points, total: cum, count: paidTx.length, mode };
  }

  // Daily: aggregate per day
  if (mode === "daily"){
    const byDay = new Map();
    for (const p of paidTx){
      const d0 = startOfDayMs(p.t);
      byDay.set(d0, (byDay.get(d0) || 0) + p.a);
    }
    const days = Array.from(byDay.keys()).sort((a,b)=> a-b);
    let cum = 0;
    const points = days.map(d0 => {
      const sum = byDay.get(d0) || 0;
      cum += sum;
      const t = d0 + (12 * 60 * 60 * 1000);
      return { t, a: sum, cum };
    });
    return { points, total: cum, count: paidTx.length, mode };
  }

  // Monthly: aggregate per month within selected year
  if (mode === "monthly"){
    const byMonth = new Map(); // key: 1..12
    for (const p of paidTx){
      const d = new Date(p.t);
      const m = d.getMonth() + 1;
      byMonth.set(m, (byMonth.get(m) || 0) + p.a);
    }
    const months = Array.from(byMonth.keys()).sort((a,b)=> a-b);
    let cum = 0;
    const year = Number(state.year);
    const points = months.map(m => {
      const sum = byMonth.get(m) || 0;
      cum += sum;
      const t = new Date(year, m-1, 15, 12, 0, 0, 0).getTime();
      return { t, a: sum, cum };
    });
    return { points, total: cum, count: paidTx.length, mode };
  }

  // Yearly: aggregate per year
  const byYear = new Map();
  for (const p of paidTx){
    const y = new Date(p.t).getFullYear();
    byYear.set(y, (byYear.get(y) || 0) + p.a);
  }
  const years = Array.from(byYear.keys()).sort((a,b)=> a-b);
  let cum = 0;
  const points = years.map(y => {
    const sum = byYear.get(y) || 0;
    cum += sum;
    const t = new Date(y, 6, 1, 12, 0, 0, 0).getTime();
    return { t, a: sum, cum };
  });
  return { points, total: cum, count: paidTx.length, mode };
}

function niceNum(v){
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n === 0) return 1;
  const exp = Math.floor(Math.log10(Math.abs(n)));
  const f = n / Math.pow(10, exp);
  let nf = 1;
  if (f < 1.5) nf = 1;
  else if (f < 3) nf = 2;
  else if (f < 7) nf = 5;
  else nf = 10;
  return nf * Math.pow(10, exp);
}

function fmtCompactMoney(v){
  const n = Number(v||0);
  if (!Number.isFinite(n)) return "฿ 0";
  return "฿ " + n.toLocaleString("th-TH");
}

function fmtHHMM(ms){
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// แกน X: แสดงแบบช่วงๆ + เดือนเป็น "ชื่อเดือน" เฉพาะบนกราฟ
function xLabelFor(ms, mode){
  const d = new Date(ms);
  if (mode === "intraday") return fmtHHMM(ms);
  if (mode === "daily") return String(d.getDate());
  if (mode === "monthly") return CHART_MONTHS_SHORT[d.getMonth()] || CHART_MONTHS_EN[d.getMonth()] || String(d.getMonth()+1);
  return String(d.getFullYear());
}

function toRGBA(c, a){
  const s = String(c || "").trim();
  if (s.startsWith("rgb(")) return s.replace("rgb(", "rgba(").replace(")", `,${a})`);
  if (s.startsWith("rgba(")) return s.replace(/rgba\(([^)]+),\s*[0-9.]+\)/, `rgba($1,${a})`);
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)){
    let x = s.slice(1);
    if (x.length === 3) x = x.split("").map(ch => ch+ch).join("");
    const r = parseInt(x.slice(0,2),16);
    const g = parseInt(x.slice(2,4),16);
    const b = parseInt(x.slice(4,6),16);
    return `rgba(${r},${g},${b},${a})`;
  }
  // fallback green
  return `rgba(0,170,90,${a})`;
}

function renderChart(){
  const canvas = $("chartCanvas");
  const meta = $("chartMeta");
  if (!canvas) return;

  const { points, total, count, mode } = buildCumulativeSeries();

  if (meta){
    meta.textContent = `${count.toLocaleString("en-US")} transactions • Cumulative ${fmtCompactMoney(total)} • ${rangeHintText()}`;
  }

  const ctx = canvas.getContext("2d");
  if (!points.length){
    // clear
    ctx.clearRect(0,0,canvas.width,canvas.height);
    return;
  }

  // HiDPI responsive
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(320, Math.floor(rect.width));
  const H = Math.max(220, Math.floor(rect.height));
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);

  const cs = getComputedStyle(document.documentElement);
  const text = (cs.getPropertyValue("--text") || "#111").trim();
  const muted = (cs.getPropertyValue("--muted") || "rgba(0,0,0,.6)").trim();
  const grid = (cs.getPropertyValue("--line") || "rgba(0,0,0,.12)").trim();
  const green = (cs.getPropertyValue("--good") || "rgba(0,170,90,0.95)").trim();

  const padL = 56, padR = 18, padT = 14, padB = 54;
  const x0 = padL, y0 = padT, x1 = W - padR, y1 = H - padB;

  const tMin = points[0].t;
  const tMax = points[points.length-1].t;
  const yMax = points[points.length-1].cum;

  const yStep = niceNum(yMax / 4);
  const yTop = Math.ceil(yMax / yStep) * yStep;

  const xFor = (t) => {
    if (tMax === tMin) return (x0 + x1) / 2;
    return x0 + ((t - tMin) / (tMax - tMin)) * (x1 - x0);
  };
  const yFor = (v) => y1 - (v / yTop) * (y1 - y0);

  ctx.clearRect(0,0,W,H);

  // Grid + Y labels
  ctx.lineWidth = 1;
  ctx.strokeStyle = grid;
  ctx.fillStyle = muted;
  ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Noto Sans Thai, Arial";

  for (let i=0;i<=4;i++){
    const v = i * yStep;
    const y = yFor(v);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.fillText("฿ " + v.toLocaleString("th-TH"), 8, y + 4);
  }

  const pts = points.map(p => ({ x: xFor(p.t), y: yFor(p.cum), t: p.t, cum: p.cum }));

  // X axis baseline
  ctx.beginPath();
  ctx.moveTo(x0, y1);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  // X labels: show a few ticks (range-like), not every point
  const n = pts.length;
  const base = W < 520 ? 6 : 8;
  let want = Math.min(n, base);
  if (mode === "monthly") want = Math.min(n, W < 520 ? 6 : 12);
  if (mode === "yearly") want = Math.min(n, W < 520 ? 5 : 10);
  const idx = [];
  if (n === 1){
    idx.push(0);
  } else {
    for (let i=0;i<want;i++){
      const k = Math.round(i * (n-1) / Math.max(1, (want-1)));
      idx.push(k);
    }
  }
  // unique indices
  const uniq = Array.from(new Set(idx));

  ctx.fillStyle = muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const seenLbl = new Set();
  for (const i of uniq){
    const x = pts[i].x;
    ctx.beginPath();
    ctx.moveTo(x, y1);
    ctx.lineTo(x, y1 + 6);
    ctx.stroke();
    const lbl = xLabelFor(points[i].t, mode);
    if (!lbl) continue;
    // avoid repeated tick text (e.g. many points within same minute)
    if (seenLbl.has(lbl) && i !== 0 && i !== n-1) continue;
    seenLbl.add(lbl);
    ctx.fillText(lbl, x, y1 + 8);
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Fill area (lighter, more transparent green)
  const grad = ctx.createLinearGradient(0, y0, 0, y1);
  grad.addColorStop(0, toRGBA(green, 0.20));
  grad.addColorStop(1, toRGBA(green, 0.00));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, y1);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.lineTo(pts[pts.length-1].x, y1);
  ctx.closePath();
  ctx.fill();

  // Line
  ctx.strokeStyle = green;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();

  // Points
  ctx.fillStyle = green;
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 2;
  for (const p of pts){
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.2, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
  }

  // Last tag
  const last = pts[pts.length-1];
  const tag = fmtCompactMoney(points[points.length-1].cum);
  ctx.font = "600 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Noto Sans Thai, Arial";
  const tw = ctx.measureText(tag).width;
  const bx = Math.min(x1 - tw - 10, last.x + 10);
  const by = Math.max(y0 + 12, last.y - 18);

  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx-6, by-14, tw+12, 20, 8);
  else {
    // fallback (no roundRect)
    ctx.rect(bx-6, by-14, tw+12, 20);
  }
  ctx.fill();

  ctx.fillStyle = text;
  ctx.fillText(tag, bx, by);
}

window.addEventListener("resize", () => updateChartIfOpen());

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

/* ===== init ===== */
(() => {
  const theme = localStorage.getItem("theme") || "dark";
  setTheme(theme);

  const savedId = localStorage.getItem("deviceId");
  const savedMs = localStorage.getItem("refreshMs");
  const savedY  = localStorage.getItem("year");
  const savedM  = localStorage.getItem("month");
  const savedD  = localStorage.getItem("day");

  $("deviceId").value = savedId || "ALL";
  $("refreshMs").value = savedMs || "2000";

  state.year  = savedY || "";
  state.month = savedM || "";
  state.day   = savedD || "";

  applyDeviceAndRefresh();

  setTimeout(() => {
    $("pickYear").value = state.year || "";
    $("pickMonth").value = state.month || "";
    buildDayOptions();
    $("pickDay").value = state.day || "";
    $("rangeHint").textContent = rangeHintText();
    applyFilters();

    // GPS map (throttled)
    refreshLocations().catch(()=>{});
  }, 300);
})();
