import { createStore, isDemo } from "./store.js";

/* ================= Defaults ================= */
const DEFAULT_SETTINGS = {
  shopName: "My Laundry",
  currency: "GH₵",
  shopPhone: "",
  countryCode: "233",
  items: [
    { id: "shirt", name: "Shirts", price: 10, prices: { both: 10, wash: 7, iron: 4 } },
    { id: "trousers", name: "Trousers", price: 10, prices: { both: 10, wash: 7, iron: 4 } },
    { id: "jeans", name: "Jeans", price: 15, prices: { both: 15, wash: 10, iron: 6 } },
    { id: "dress", name: "Dresses", price: 15, prices: { both: 15, wash: 10, iron: 6 } },
    { id: "bedsheet", name: "Bedsheets", price: 20, prices: { both: 20, wash: 15, iron: 8 } },
    { id: "pillowcase", name: "Pillowcases", price: 5, prices: { both: 5, wash: 4, iron: 2 } },
    { id: "duvet", name: "Duvets", price: 50, prices: { both: 50, wash: 50, iron: null } },
    { id: "singlet", name: "Singlets", price: 5, prices: { both: 5, wash: 4, iron: 2 } },
    { id: "boxers", name: "Boxers", price: 5, prices: { both: 5, wash: 4, iron: null } },
  ],
  expenseCategories: ["Soap", "Detergent", "Bleach / Starch", "Electricity bill", "Water bill", "Gas / Fuel", "Rent", "Wages", "Other"],
};

/* ================= Services ================= */
const SERVICES = [
  { id: "both", label: "Wash & iron" },
  { id: "wash", label: "Wash only" },
  { id: "iron", label: "Iron only" },
];
const svcLabel = (id) => SERVICES.find((s) => s.id === id)?.label || "";
// Price of an item for a service, or null if that service isn't offered for it.
// Price lists saved before services existed have a single price: it is used for
// Wash & iron and Wash only, and Iron only stays off until the manager sets a price.
function priceFor(it, svc) {
  if (it.prices) { const v = it.prices[svc]; return v === null || v === undefined || v === "" ? null : num(v); }
  return svc === "iron" ? null : num(it.price);
}
// Group an order's lines by service, keeping the order of SERVICES. Lines saved
// before services existed have no service and form their own group with no label.
function linesByService(o) {
  const groups = [];
  [...SERVICES.map((s) => s.id), ""].forEach((svc) => {
    const ls = (o.lines || []).filter((l) => (l.service || "") === svc);
    if (ls.length) groups.push({ svc, label: svcLabel(svc), lines: ls });
  });
  return groups;
}

/* ================= State ================= */
let store;
let settings = structuredClone(DEFAULT_SETTINGS);
let orders = [];
let expenses = [];
let unsubs = [];
let currentUser = null;
let profile = null; // { role, name, shopId, owner }
let isManager = false;
let members = [];
let invites = [];
let editingId = null; // order being edited
let qty = {}; // itemId -> count on the order form
let linePrices = {}; // itemId -> price (frozen prices when editing)
let lineNames = {}; // itemId -> name (for items removed from the price list since)
// qty and linePrices are keyed "service:itemId", so one order can mix services.
let service = "both"; // service shown on the order form
try { service = localStorage.getItem("laundry-service") || "both"; } catch {}
const keyOf = (svc, id) => `${svc}:${id}`;
let orderFilter = "waiting";
let period = "today";

/* ================= Helpers ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const money = (v) => `${settings.currency} ${num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const moneyShort = (v) => `${settings.currency} ${num(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const subtotalOf = (o) => num(o.subtotal ?? o.total);
const discountOf = (o) => num(o.discount);
const r2 = (v) => Math.round(num(v) * 100) / 100;
// All payments on an order, oldest first. Orders saved before part payments existed have no
// list: a paid one counts as a single full payment on the day it was marked paid.
const paymentsOf = (o) => Array.isArray(o.payments) ? o.payments
  : o.paid ? [{ amount: num(o.total), date: o.paidOn, by: o.paidBy || "", byUid: o.paidByUid || "" }] : [];
const paidSoFar = (o) => r2(paymentsOf(o).reduce((s, p) => s + num(p.amount), 0));
const balanceOf = (o) => Math.max(0, r2(num(o.total) - paidSoFar(o)));
const fullyPaid = (o) => balanceOf(o) <= 0 && (paidSoFar(o) > 0 || num(o.total) <= 0);
const allPayments = () => orders.flatMap((o) => paymentsOf(o).map((p) => ({ ...p, order: o })));
// Fields to save whenever an order's payment list changes.
function paymentFields(total, payments) {
  const sum = r2(payments.reduce((s, p) => s + num(p.amount), 0));
  const last = payments[payments.length - 1];
  const full = (payments.length > 0 && sum >= r2(total)) || num(total) <= 0;
  return { payments, paid: full, paidOn: full && last ? last.date : null, paidBy: full && last ? last.by : null, paidByUid: full && last ? last.byUid : null };
}
const me = () => ({ name: profile?.name || "", uid: currentUser?.uid || "" });
const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);
const fmtDate = (s) => {
  if (!s) return "";
  const d = parseISO(s);
  const t = today();
  if (s === t) return "today";
  if (s === iso(addDays(new Date(), -1))) return "yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() && { year: "numeric" }) });
};
const startOfWeek = (d = new Date()) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); }; // Monday
const ticketStr = (n) => `#${String(n).padStart(3, "0")}`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "item";

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove("show"); setTimeout(() => (t.hidden = true), 250); }, 2200);
}

function askDate(title, text, initial = today(), balance = null) {
  const dlg = $("#dateDialog");
  const withAmt = balance !== null;
  $("#dateDialogTitle").textContent = title;
  $("#dateDialogText").textContent = text;
  $("#dateDialogInput").value = initial;
  $("#dateDialogInput").max = today();
  $("#dateDialogAmtWrap").hidden = !withAmt;
  $("#dateDialogQuick").hidden = !withAmt;
  const amt = $("#dateDialogAmt");
  amt.required = withAmt;
  if (withAmt) {
    amt.value = balance;
    amt.max = balance;
    $$(".cur-sym").forEach((x) => (x.textContent = settings.currency));
    $("#dateDialogQuick").innerHTML = `<button type="button" class="btn small ghost" data-amt="${balance}">Full balance ${money(balance)}</button>`;
  }
  dlg.showModal();
  if (withAmt) { amt.focus(); amt.select(); }
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      if (dlg.returnValue !== "ok") return resolve(null);
      const date = $("#dateDialogInput").value;
      resolve(withAmt ? { amount: r2(amt.value), date } : date);
    }, { once: true });
  });
}
$("#dateDialogQuick").addEventListener("click", (e) => {
  const b = e.target.closest("[data-amt]"); if (b) $("#dateDialogAmt").value = b.dataset.amt;
});
$("#dateDialogAmt").addEventListener("input", (e) => {
  const v = num(e.target.value), max = num(e.target.max);
  e.target.setCustomValidity(v > max ? `That's more than the balance (${money(max)})` : v <= 0 ? "Enter the amount paid" : "");
});

/* ================= Boot & auth ================= */
async function boot() {
  try {
    store = await createStore();
  } catch (e) {
    console.error(e);
    $("#boot").innerHTML = `<p class="error" style="padding:24px">Could not load Firebase. Check your internet connection and refresh.</p>`;
    return;
  }
  $("#demoBanner").hidden = !isDemo;
  store.onAuth(startSession);
}

const screen = (name) => ["boot", "auth", "setup", "app"].forEach((k) => ($(`#${k}`).hidden = k !== name));

async function startSession(user) {
  currentUser = user;
  unsubs.forEach((u) => u()); unsubs = [];
  orders = []; expenses = []; members = []; invites = [];
  if (!user) return screen("auth");
  screen("boot");
  try {
    profile = await store.loadProfile(user);
  } catch (e) {
    console.error(e);
    $("#boot").innerHTML = `<div style="padding:24px;text-align:center"><p class="error">Could not load your shop. Check your internet connection.</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  if (profile.status !== "ok") return showSetup(user, profile.status);

  isManager = profile.role === "manager";
  document.body.classList.toggle("staff", !isManager);
  document.body.classList.toggle("manager", isManager);
  $("#roleChip").textContent = isManager ? "Manager" : "Staff";
  $("#reportsTabLabel").textContent = isManager ? "Reports" : "Today";
  $("#reportsTitle").textContent = isManager ? "Reports" : "Today";
  $("#settingsTabLabel").textContent = isManager ? "Settings" : "Account";
  $$("#demoRole button").forEach((b) => b.classList.toggle("active", b.dataset.r === profile.role));
  $("#accountEmail").innerHTML = `${esc(profile.name)} <span class="muted">· ${isManager ? "Manager" : "Shop staff"}</span><div class="muted small">${esc(user.email)}</div>`;
  if (!isManager) period = "today";
  screen("app");

  unsubs.push(store.watch("settings", (s) => {
    if (!s && isManager) store.saveSettings(DEFAULT_SETTINGS);
    settings = { ...structuredClone(DEFAULT_SETTINGS), ...(s || {}) };
    applySettings();
  }));
  unsubs.push(store.watch("orders", (list) => { orders = list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); renderAll(); }));
  unsubs.push(store.watch("expenses", (list) => { expenses = list.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0)); renderAll(); }));
  if (isManager) {
    unsubs.push(store.watch("members", (list) => { members = list; renderStaff(); }));
    unsubs.push(store.watch("invites", (list) => { invites = list; renderStaff(); }));
  }
  resetOrderForm();
  const cur = $$("#tabs button").find((b) => b.classList.contains("active"))?.dataset.view || "new";
  show(cur);
}

function showSetup(user, status) {
  screen("setup");
  $("#setupEmail2").textContent = user.email;
  $("#setupName").value = user.displayName || $("#authName").value || "";
  $("#setupTitle").textContent = status === "removed" ? "No access" : "Welcome";
  $("#setupSub").innerHTML = status === "removed"
    ? `<b>${esc(user.email)}</b> is no longer on a shop's staff list. Ask the manager to add you again.`
    : `Signed in as <b>${esc(user.email)}</b>`;
}
$("#setupRefresh").onclick = () => startSession(currentUser);
$("#setupSignOut").onclick = () => store.signOut();
$("#setupForm").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("#setupForm button"); btn.disabled = true;
  try {
    await store.createShop(currentUser, $("#setupShop").value.trim(), $("#setupName").value.trim(), DEFAULT_SETTINGS);
    await startSession(currentUser);
  } catch (ex) { console.error(ex); alert("Could not create the shop: " + (ex.message || ex)); }
  finally { btn.disabled = false; }
};
$("#demoRole").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-r]"); if (!b || !store.switchRole) return;
  store.switchRole(b.dataset.r);
});

let signUpMode = false;
$("#authToggle").onclick = () => {
  signUpMode = !signUpMode;
  $("#authSubmit").textContent = signUpMode ? "Create account" : "Sign in";
  $("#authToggle").textContent = signUpMode ? "Already have an account? Sign in" : "First time? Create an account";
  $("#authNameWrap").hidden = !signUpMode;
  $("#authName").required = signUpMode;
  $("#authPass").autocomplete = signUpMode ? "new-password" : "current-password";
};
$("#authForm").onsubmit = async (e) => {
  e.preventDefault();
  const err = $("#authError"); err.hidden = true;
  const btn = $("#authSubmit"); btn.disabled = true;
  try {
    const em = $("#authEmail").value.trim(), pw = $("#authPass").value;
    await (signUpMode ? store.signUp(em, pw, $("#authName").value.trim()) : store.signIn(em, pw));
  } catch (ex) {
    err.textContent = friendlyAuthError(ex); err.hidden = false;
  } finally { btn.disabled = false; }
};
$("#authReset").onclick = async () => {
  const em = $("#authEmail").value.trim();
  const err = $("#authError");
  if (!em) { err.textContent = "Type your email above first."; err.hidden = false; return; }
  try { await store.resetPassword(em); err.hidden = true; toast("Password reset email sent"); }
  catch (ex) { err.textContent = friendlyAuthError(ex); err.hidden = false; }
};
function friendlyAuthError(e) {
  const c = e?.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Wrong email or password.";
  if (c.includes("email-already-in-use")) return "That email already has an account. Sign in instead.";
  if (c.includes("weak-password")) return "Password must be at least 6 characters.";
  if (c.includes("network")) return "No internet connection.";
  return e?.message || "Something went wrong.";
}
$("#signOut").onclick = () => { if (isDemo) return toast("Demo mode has no account. Use the switch at the top."); store.signOut(); };

/* ================= Navigation ================= */
function show(view) {
  if (view === "new" && editingId && !isManager) resetOrderForm();
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  window.scrollTo({ top: 0 });
  try { sessionStorage.setItem("view", view); } catch {}
}
$$("#tabs button").forEach((b) => (b.onclick = () => show(b.dataset.view)));
try { const v = sessionStorage.getItem("view"); if (v && $(`#view-${v}`)) show(v); } catch {}

/* ================= Settings ================= */
function applySettings() {
  $("#shopName").textContent = settings.shopName;
  document.title = `${settings.shopName} · Laundry Book`;
  // Settings form
  $("#sShop").value = settings.shopName;
  $("#sCur").value = settings.currency;
  $("#sPhone").value = settings.shopPhone || "";
  $("#sCC").value = settings.countryCode || "";
  $("#sExpCats").value = settings.expenseCategories.join("\n");
  renderPriceRows(settings.items);
  // Expense categories
  const sel = $("#eCat"), prev = sel.value;
  sel.innerHTML = settings.expenseCategories.map((c) => `<option>${esc(c)}</option>`).join("");
  if (settings.expenseCategories.includes(prev)) sel.value = prev;
  if (!editingId) renderItemRows();
  renderAll();
}

function renderPriceRows(items) {
  $("#priceRows").innerHTML = items.map((it, i) => `
    <div class="price-row" data-i="${i}" data-id="${esc(it.id)}">
      <input class="pName" value="${esc(it.name)}" required aria-label="Item name" />
      ${SERVICES.map((s) => { const v = priceFor(it, s.id); return `
      <label class="pcell"><span>${s.label}</span><input class="pPrice" data-svc="${s.id}" type="number" inputmode="decimal" step="0.01" min="0" value="${v === null ? "" : v}" placeholder="—" aria-label="${esc(it.name)} ${s.label} price" /></label>`; }).join("")}
      <button type="button" class="icon-btn pDel" title="Remove" aria-label="Remove ${esc(it.name)}">✕</button>
    </div>`).join("");
  const missingIron = items.some((it) => !it.prices);
  $("#priceNote").hidden = !missingIron;
}
function readPriceRows() {
  return $$("#priceRows .price-row").map((r) => {
    const prices = {};
    $$(".pPrice", r).forEach((inp) => { prices[inp.dataset.svc] = inp.value.trim() === "" ? null : num(inp.value); });
    return {
      id: r.dataset.id || slug($(".pName", r).value),
      name: $(".pName", r).value.trim(),
      price: prices.both ?? prices.wash ?? prices.iron ?? 0, // kept for older app versions
      prices,
    };
  }).filter((x) => x.name);
}
$("#priceRows").addEventListener("click", (e) => {
  if (e.target.closest(".pDel")) e.target.closest(".price-row").remove();
});
$("#addItemType").onclick = () => {
  const items = readPriceRows();
  items.push({ id: `${slug("new")}-${Date.now().toString(36)}`, name: "", price: 0, prices: { both: null, wash: null, iron: null } });
  renderPriceRows(items);
  $("#priceRows .price-row:last-child .pName").focus();
};
$("#settingsForm").onsubmit = async (e) => {
  e.preventDefault();
  const items = readPriceRows();
  const seen = new Set();
  items.forEach((it) => { while (seen.has(it.id)) it.id += "-2"; seen.add(it.id); });
  const s = {
    shopName: $("#sShop").value.trim() || "My Laundry",
    currency: $("#sCur").value.trim() || "GH₵",
    shopPhone: $("#sPhone").value.trim(),
    countryCode: $("#sCC").value.replace(/\D/g, ""),
    items,
    expenseCategories: $("#sExpCats").value.split("\n").map((x) => x.trim()).filter(Boolean),
  };
  if (!s.expenseCategories.length) s.expenseCategories = ["Other"];
  await store.saveSettings(s);
  toast("Settings saved");
};

/* ================= Order form ================= */
// Items the form shows for one service. When editing, items already on the order keep
// the price they were charged; items not offered for this service are left out.
function formItems(svc = service) {
  const list = settings.items
    .map((it) => { const k = keyOf(svc, it.id); return { id: it.id, key: k, name: it.name, price: linePrices[k] ?? priceFor(it, svc) }; })
    .filter((it) => it.price !== null);
  Object.keys(linePrices).forEach((k) => {
    const [s, id] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    if (s === svc && !list.find((x) => x.key === k)) list.push({ id, key: k, name: lineNames[id] || id, price: linePrices[k] });
  });
  return list;
}
// Every counted item on the form, across all services.
function formLines() {
  return SERVICES.flatMap((s) => formItems(s.id).filter((it) => qty[it.key] > 0)
    .map((it) => ({ id: it.id, name: it.name, price: it.price, qty: qty[it.key], service: s.id })));
}
function renderSvcTabs() {
  const counts = Object.fromEntries(SERVICES.map((s) => [s.id, formItems(s.id).reduce((n, it) => n + (qty[it.key] || 0), 0)]));
  $("#svcTabs").innerHTML = SERVICES.map((s) => `
    <button type="button" role="tab" aria-selected="${s.id === service}" class="${s.id === service ? "active" : ""}" data-svc="${s.id}">
      ${s.label}${counts[s.id] ? ` <b>${counts[s.id]}</b>` : ""}</button>`).join("");
  const others = SERVICES.filter((s) => s.id !== service && counts[s.id]);
  $("#svcOther").hidden = !others.length;
  $("#svcOther").innerHTML = others.length ? `Also on this order: ${others.map((s) => `${counts[s.id]} for ${s.label.toLowerCase()}`).join(", ")}` : "";
}
$("#svcTabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-svc]"); if (!b) return;
  service = b.dataset.svc;
  try { localStorage.setItem("laundry-service", service); } catch {}
  renderItemRows();
});

function renderItemRows() {
  renderSvcTabs();
  const items = formItems();
  $("#itemRows").innerHTML = items.length ? items.map((it) => {
    const q = qty[it.key] || 0;
    return `
    <div class="item-row ${q ? "has" : ""}" data-key="${esc(it.key)}">
      <div class="item-name"><b>${esc(it.name)}</b><span class="muted small">${money(it.price)} each</span></div>
      <div class="stepper">
        <button type="button" class="minus" aria-label="Less ${esc(it.name)}">−</button>
        <input type="number" inputmode="numeric" min="0" value="${q || ""}" placeholder="0" aria-label="${esc(it.name)} count" />
        <button type="button" class="plus" aria-label="More ${esc(it.name)}">+</button>
      </div>
      <div class="line-total">${q ? money(q * it.price) : ""}</div>
    </div>`;
  }).join("") : `<div class="empty small">No prices set for ${esc(svcLabel(service).toLowerCase())}. The manager can add them in Settings → Price list.</div>`;
  updateTotal();
}

function updateTotal() {
  const items = formItems();
  let count = 0, total = 0;
  formLines().forEach((l) => { count += l.qty; total += l.qty * l.price; });
  total = r2(total);
  const disc = Math.max(0, num($("#oDiscount").value));
  const tooBig = disc > total;
  $("#oDiscount").setCustomValidity(tooBig ? "The discount can't be more than the bill" : "");
  const pays = Math.max(0, total - disc);
  $("#oTotal").textContent = money(pays);
  $("#oDiscNote").hidden = !disc;
  $("#oDiscNote").textContent = disc ? `after ${money(disc)} off` : "";
  $("#oBill").hidden = !disc;
  $("#oBill").classList.toggle("bad", tooBig);
  $("#oSubtotal").textContent = money(total);
  $("#oDiscShow").textContent = `− ${money(disc)}`;
  $("#oPays").textContent = tooBig ? "Discount too big" : money(pays);
  $("#oDiscCur").textContent = settings.currency;
  updatePayNote(pays);
  $("#oCount").textContent = `${count} item${count === 1 ? "" : "s"}`;
  $$("#itemRows .item-row").forEach((row) => {
    const it = items.find((x) => x.key === row.dataset.key); if (!it) return; const q = qty[it.key] || 0;
    row.classList.toggle("has", q > 0);
    $(".line-total", row).textContent = q ? money(q * it.price) : "";
  });
}

$("#oDiscount").addEventListener("input", updateTotal);

// "Amount paid now" on the order form. payFull keeps it equal to the bill while items change.
let payFull = false;
function updatePayNote(bill) {
  const box = $("#oPayNote"), amtIn = $("#oPaidAmt");
  $$(".cur-sym").forEach((x) => (x.textContent = settings.currency));
  if (editingId) {
    const o = orders.find((x) => x.id === editingId) || {};
    const pd = paidSoFar(o), bal = Math.max(0, r2(bill - pd));
    box.className = "pay-note";
    box.innerHTML = pd > 0
      ? `Paid so far <b>${money(pd)}</b> · ${bal > 0 ? `balance <b>${money(bal)}</b>` : "fully paid"}<div class="muted small">Use <b>Take payment</b> on the order to add a payment.</div>`
      : `Not paid yet<div class="muted small">Use <b>Take payment</b> on the order when the customer pays.</div>`;
    return;
  }
  if (payFull) amtIn.value = bill > 0 ? r2(bill) : "";
  const paid = r2(amtIn.value);
  amtIn.setCustomValidity(paid > r2(bill) ? "That's more than the bill" : "");
  $("#oPaidOnWrap").hidden = !(paid > 0);
  $("#oPayFull").classList.toggle("on", payFull);
  $("#oPayNone").classList.toggle("on", !paid);
  if (!bill) { box.className = "pay-note"; box.textContent = ""; return; }
  if (paid > r2(bill)) { box.className = "pay-note bad"; box.textContent = "That's more than the bill"; return; }
  if (paid <= 0) { box.className = "pay-note"; box.innerHTML = `Not paid yet · customer owes <b>${money(bill)}</b>`; return; }
  if (paid >= r2(bill)) { box.className = "pay-note ok"; box.innerHTML = "✓ Paid in full"; return; }
  box.className = "pay-note part";
  box.innerHTML = `Part payment · balance <b>${money(r2(bill - paid))}</b> to pay later`;
}
$("#oPaidAmt").addEventListener("input", () => { payFull = false; updateTotal(); });
$("#oPaidAmt").addEventListener("focus", (e) => e.target.select());
$("#oPayFull").onclick = () => { payFull = true; updateTotal(); };
$("#oPayNone").onclick = () => { payFull = false; $("#oPaidAmt").value = ""; updateTotal(); };
$("#oDiscount").addEventListener("focus", (e) => e.target.select());

$("#itemRows").addEventListener("click", (e) => {
  const row = e.target.closest(".item-row"); if (!row) return;
  const id = row.dataset.key, inp = $("input", row);
  if (e.target.closest(".plus")) qty[id] = (qty[id] || 0) + 1;
  else if (e.target.closest(".minus")) qty[id] = Math.max(0, (qty[id] || 0) - 1);
  else return;
  inp.value = qty[id] || "";
  updateTotal();
  renderSvcTabs();
});
$("#itemRows").addEventListener("input", (e) => {
  const row = e.target.closest(".item-row"); if (!row) return;
  qty[row.dataset.key] = Math.max(0, Math.floor(num(e.target.value)));
  updateTotal();
  renderSvcTabs();
});
$("#itemRows").addEventListener("focusin", (e) => { if (e.target.matches("input")) e.target.select(); });

$("#oName").addEventListener("change", () => {
  // Fill phone for returning customers
  const n = $("#oName").value.trim().toLowerCase();
  if ($("#oPhone").value) return;
  const prev = orders.find((o) => (o.customer || "").toLowerCase() === n && o.phone);
  if (prev) $("#oPhone").value = prev.phone;
});

function nextTicket() { return orders.reduce((m, o) => Math.max(m, o.ticket || 0), 0) + 1; }

function resetOrderForm() {
  editingId = null; qty = {}; linePrices = {}; lineNames = {};
  try { service = localStorage.getItem("laundry-service") || "both"; } catch { service = "both"; }
  $("#orderForm").reset();
  $("#oDate").value = today();
  $("#oPaidOn").value = today();
  $("#oPaidOnWrap").hidden = true;
  $("#oPayEntry").hidden = false;
  payFull = false;
  $("#orderFormTitle").textContent = "New order";
  $("#orderTicket").textContent = `Ticket ${ticketStr(nextTicket())}`;
  $("#oSave").textContent = "Save order";
  $("#oCancel").hidden = true;
  renderItemRows();
}
$("#oCancel").onclick = () => { resetOrderForm(); show("orders"); };

function startEdit(o) {
  editingId = o.id; qty = {}; linePrices = {}; lineNames = {};
  (o.lines || []).forEach((l) => {
    const k = keyOf(l.service || "wash", l.id);
    qty[k] = (qty[k] || 0) + l.qty; linePrices[k] = l.price; lineNames[l.id] = l.name;
  });
  service = (o.lines || [])[0]?.service || "wash";
  $("#oName").value = o.customer || "";
  $("#oPhone").value = o.phone || "";
  $("#oDate").value = o.dropDate || today();
  $("#oNote").value = o.note || "";
  $("#oDiscount").value = discountOf(o) || "";
  $("#oPayEntry").hidden = true; // payments are added from the order card while editing
  payFull = false;
  $("#orderFormTitle").textContent = "Edit order";
  $("#orderTicket").textContent = `Ticket ${ticketStr(o.ticket)}`;
  $("#oSave").textContent = "Save changes";
  $("#oCancel").hidden = false;
  renderItemRows();
  show("new");
}

$("#orderForm").onsubmit = async (e) => {
  e.preventDefault();
  const lines = formLines();
  if (!lines.length) return toast("Add at least one item");
  const subtotal = Math.round(lines.reduce((s, l) => s + l.qty * l.price, 0) * 100) / 100;
  const discount = Math.round(Math.max(0, num($("#oDiscount").value)) * 100) / 100;
  if (discount > subtotal) return toast("The discount can't be more than the bill");
  const total = r2(subtotal - discount);
  const paidNow = editingId ? 0 : r2($("#oPaidAmt").value);
  if (paidNow > total) return toast("The amount paid is more than the bill");
  const data = {
    customer: $("#oName").value.trim(),
    phone: $("#oPhone").value.trim(),
    dropDate: $("#oDate").value,
    note: $("#oNote").value.trim(),
    lines,
    subtotal,
    discount,
    total: Math.round(total * 100) / 100,
    itemCount: lines.reduce((s, l) => s + l.qty, 0),
  };
  if (editingId) {
    if (!isManager) return toast("Only the manager can edit orders");
    const before = orders.find((o) => o.id === editingId);
    Object.assign(data, paymentFields(data.total, paymentsOf(before || {})));
    if (discount !== discountOf(before || {})) { data.discountBy = discount ? me().name : null; }
    await store.update("orders", editingId, data);
    toast("Order updated");
  } else {
    data.ticket = nextTicket();
    data.createdAt = Date.now();
    data.createdBy = me().name; data.createdByUid = me().uid;
    if (discount) data.discountBy = me().name;
    const payments = paidNow > 0 ? [{ amount: paidNow, date: $("#oPaidOn").value || today(), by: me().name, byUid: me().uid }] : [];
    Object.assign(data, paymentFields(data.total, payments));
    data.collected = false;
    data.collectedOn = null;
    await store.add("orders", data);
    const bal = r2(total - paidNow);
    toast(`Saved ${ticketStr(data.ticket)} · ${money(total)}${paidNow > 0 && bal > 0 ? ` · balance ${money(bal)}` : ""}`);
  }
  const wasEditing = !!editingId;
  resetOrderForm();
  if (wasEditing) show("orders");
};

function payPill(o) {
  if (fullyPaid(o)) {
    const ps = paymentsOf(o), last = ps[ps.length - 1] || {};
    return `<span class="pill ok">✓ Paid${ps.length > 1 ? " in full" : ""} ${fmtDate(last.date || o.paidOn)}${last.by ? ` · ${esc(last.by)}` : ""}</span>`;
  }
  const pd = paidSoFar(o);
  if (pd > 0) return `<span class="pill part" title="Paid ${money(pd)} so far">◐ Owes ${money(balanceOf(o))}</span>`;
  return `<span class="pill warn">● Not paid</span>`;
}
function receiptPayLines(o) {
  const pd = paidSoFar(o), bal = balanceOf(o);
  if (fullyPaid(o)) return ["Paid in full ✓"];
  if (pd > 0) return [`Paid so far: ${money(pd)}`, `*Balance to pay: ${money(bal)}*`];
  return ["Not paid yet"];
}

/* ================= Orders list ================= */
function filteredOrders() {
  const q = $("#search").value.trim().toLowerCase().replace(/^#/, "");
  const t = today();
  return orders.filter((o) => {
    if (q) {
      const hay = `${o.customer} ${o.phone} ${o.ticket} ${String(o.ticket).padStart(3, "0")} ${o.note}`.toLowerCase();
      if (!hay.includes(q)) return false;
      return true; // search ignores the filter chip
    }
    switch (orderFilter) {
      case "waiting": return !o.collected;
      case "unpaid": return balanceOf(o) > 0;
      case "today": return o.dropDate === t || paymentsOf(o).some((p) => p.date === t) || o.collectedOn === t;
      case "collected": return o.collected;
      default: return true;
    }
  });
}

function renderOrders() {
  const list = filteredOrders();
  const shown = list.slice(0, 200);
  const owingView = orderFilter === "unpaid" && !$("#search").value.trim();
  const sum = list.reduce((s, o) => s + (owingView ? balanceOf(o) : num(o.total)), 0);
  $("#orderSummary").textContent = list.length ? `${list.length} order${list.length === 1 ? "" : "s"} · ${money(sum)}${owingView ? " still owed" : ""}${list.length > shown.length ? " · showing latest 200" : ""}` : "";
  const waiting = orders.filter((o) => !o.collected).length;
  $("#pendingBadge").hidden = !waiting; $("#pendingBadge").textContent = waiting;

  if (!list.length) {
    $("#orderList").innerHTML = `<div class="empty">${orders.length ? "No orders match." : "No orders yet. Tap <b>New</b> to record the first drop-off."}</div>`;
    return;
  }
  const t = today();
  $("#orderList").innerHTML = shown.map((o) => {
    const waitDays = o.collected ? 0 : daysBetween(o.dropDate || t, t);
    const items = linesByService(o).map((g) => `<div>${g.label ? `<span class="svc-tag svc-${g.svc}">${g.label}</span> ` : ""}${g.lines.map((l) => `${l.qty} ${esc(l.name)}`).join(" · ")}</div>`).join("");
    return `
    <article class="order ${o.collected ? "done" : ""}" data-id="${o.id}">
      <div class="order-top">
        <div>
          <div class="order-title"><span class="tno">${ticketStr(o.ticket)}</span> ${esc(o.customer)}</div>
          <div class="muted small">${o.phone ? `${esc(o.phone)} · ` : ""}Dropped ${fmtDate(o.dropDate)}</div>
        </div>
        <div class="order-total">${money(o.total)}${discountOf(o) ? `<div class="was">${money(discountOf(o))} off</div>` : ""}</div>
      </div>
      <div class="order-items">${items}${o.note ? `<div class="note">“${esc(o.note)}”</div>` : ""}</div>
      <div class="status-row">
        ${payPill(o)}
        ${o.collected
          ? `<span class="pill ok">✓ Collected ${fmtDate(o.collectedOn)}${o.collectedBy ? ` · ${esc(o.collectedBy)}` : ""}</span>`
          : `<span class="pill ${waitDays >= 7 ? "alert" : "info"}">◷ Not collected yet${waitDays > 0 ? ` · ${waitDays} day${waitDays === 1 ? "" : "s"}` : ""}</span>`}
      </div>
      <div class="order-actions">
        ${balanceOf(o) > 0 ? `<button class="btn small primary" data-a="pay">${paidSoFar(o) > 0 ? "Take balance" : "Take payment"}</button>` : ""}
        ${!o.collected ? `<button class="btn small ${fullyPaid(o) ? "primary" : "ghost"}" data-a="collect">Mark collected</button>` : ""}
        <button class="btn small ghost share" data-a="receipt" title="${o.phone ? "Send receipt on WhatsApp" : "Share receipt"}" aria-label="${o.phone ? "Send receipt on WhatsApp" : "Share receipt"}"><svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.4A8.4 8.4 0 1 1 21 11.5z"/></svg></button>
        <details class="more">
          <summary class="btn small ghost" aria-label="More actions">⋯</summary>
          <div class="menu">
            <button data-a="print">Print receipt</button>
            ${isManager ? `<button data-a="edit">Edit order</button>
            ${paymentsOf(o).length ? `<button data-a="unpay">Undo last payment</button>` : ""}
            ${o.collected ? `<button data-a="uncollect">Undo collected</button>` : ""}
            <button data-a="delete" class="danger">Delete order</button>` : ""}
            ${paymentsOf(o).length ? `<div class="menu-note"><b>Payments</b>${paymentsOf(o).map((p) => `<div>${money(p.amount)} · ${fmtDate(p.date)}${p.by ? ` · ${esc(p.by)}` : ""}</div>`).join("")}</div>` : ""}
            ${o.createdBy ? `<div class="menu-note">Taken by ${esc(o.createdBy)}</div>` : ""}
          </div>
        </details>
      </div>
    </article>`;
  }).join("");
}

$("#orderList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-a]"); if (!btn) return;
  const card = btn.closest(".order"); const o = orders.find((x) => x.id === card.dataset.id); if (!o) return;
  btn.closest("details")?.removeAttribute("open");
  const who = `${ticketStr(o.ticket)} ${o.customer} · ${money(o.total)}`;
  if (["unpay", "uncollect", "edit", "delete"].includes(btn.dataset.a) && !isManager) return toast("Only the manager can do that");
  switch (btn.dataset.a) {
    case "pay": {
      const bal = balanceOf(o), pd = paidSoFar(o);
      const res = await askDate(pd > 0 ? "Take balance" : "Take payment",
        `${ticketStr(o.ticket)} ${o.customer} · total ${money(o.total)}${pd > 0 ? ` · paid so far ${money(pd)}` : ""} · balance ${money(bal)}`, today(), bal);
      if (!res || !(res.amount > 0)) return;
      const amount = Math.min(res.amount, bal);
      const payments = [...paymentsOf(o), { amount, date: res.date, by: me().name, byUid: me().uid }];
      await store.update("orders", o.id, paymentFields(o.total, payments));
      const left = r2(bal - amount);
      toast(left > 0 ? `${money(amount)} received · balance ${money(left)}` : "Paid in full ✓");
      break;
    }
    case "collect": {
      if (balanceOf(o) > 0 && !confirm(`${o.customer} still owes ${money(balanceOf(o))}. Mark collected anyway?`)) return;
      const d = await askDate("Mark as collected", who); if (!d) return;
      await store.update("orders", o.id, { collected: true, collectedOn: d, collectedBy: me().name, collectedByUid: me().uid }); toast("Marked collected"); break;
    }
    case "unpay": {
      const ps = paymentsOf(o), last = ps[ps.length - 1];
      if (confirm(`Remove the last payment of ${money(last.amount)} (${fmtDate(last.date)}) from ${ticketStr(o.ticket)} ${o.customer}?`))
        await store.update("orders", o.id, paymentFields(o.total, ps.slice(0, -1)));
      break;
    }
    case "uncollect": await store.update("orders", o.id, { collected: false, collectedOn: null, collectedBy: null, collectedByUid: null }); break;
    case "edit": startEdit(o); break;
    case "receipt": sendReceipt(o); break;
    case "print": printReceipt(o); break;
    case "delete":
      if (confirm(`Delete order ${who}? This cannot be undone.`)) { await store.remove("orders", o.id); toast("Order deleted"); }
      break;
  }
});
document.addEventListener("click", (e) => { $$("details.more[open]").forEach((d) => { if (!d.contains(e.target)) d.removeAttribute("open"); }); });
$("#orderFilters").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  orderFilter = b.dataset.f;
  $$("#orderFilters button").forEach((x) => x.classList.toggle("active", x === b));
  renderOrders();
});
$("#search").addEventListener("input", renderOrders);

/* ================= Receipts ================= */
function receiptText(o) {
  const lines = linesByService(o).map((g) => (g.label ? `_${g.label}_\n` : "") +
    g.lines.map((l) => `${l.qty} × ${l.name} @ ${money(l.price)} = ${money(l.qty * l.price)}`).join("\n")).join("\n");
  return [
    `*${settings.shopName}*`,
    `Ticket ${ticketStr(o.ticket)} · ${o.customer}`,
    `Dropped: ${fmtDate(o.dropDate)}`,
    "",
    lines,
    "",
    ...(discountOf(o) ? [`Subtotal: ${money(subtotalOf(o))}`, `Discount: −${money(discountOf(o))}`] : []),
    `*Total: ${money(o.total)}*`,
    ...receiptPayLines(o),
    o.collected ? `Collected ${fmtDate(o.collectedOn)}` : "Please bring this ticket number when collecting.",
    settings.shopPhone ? `\nCall us: ${settings.shopPhone}` : "",
    "Thank you!",
  ].join("\n");
}
function waNumber(phone) {
  let p = (phone || "").replace(/\D/g, "");
  if (!p) return "";
  if (p.startsWith("0") && settings.countryCode) p = settings.countryCode + p.slice(1);
  return p;
}
async function sendReceipt(o) {
  const text = receiptText(o);
  const n = waNumber(o.phone);
  if (n) { window.open(`https://wa.me/${n}?text=${encodeURIComponent(text)}`, "_blank"); return; }
  if (navigator.share) { try { await navigator.share({ text }); return; } catch { /* cancelled */ return; } }
  try { await navigator.clipboard.writeText(text); toast("Receipt copied"); } catch { printReceipt(o); }
}
function printReceipt(o) {
  const w = window.open("", "_blank", "width=380,height=600");
  if (!w) return toast("Allow pop-ups to print");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${ticketStr(o.ticket)}</title>
  <style>body{font:14px/1.45 system-ui,sans-serif;max-width:300px;margin:16px auto;color:#000}h1{font-size:18px;margin:0;text-align:center}
  .c{text-align:center}.big{font-size:28px;font-weight:700;text-align:center;margin:6px 0}table{width:100%;border-collapse:collapse;margin:10px 0}
  td{padding:3px 0;border-bottom:1px dashed #999}td:last-child{text-align:right}.tot td{font-weight:700;border:0;padding-top:8px}.sub td{border:0;padding-top:6px}.grp td{text-align:left!important;font-weight:700;border:0;padding-top:8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em}</style></head><body>
  <h1>${esc(settings.shopName)}</h1>${settings.shopPhone ? `<div class="c">${esc(settings.shopPhone)}</div>` : ""}
  <div class="big">${ticketStr(o.ticket)}</div>
  <div class="c">${esc(o.customer)}${o.phone ? ` · ${esc(o.phone)}` : ""}<br>Dropped ${esc(parseISO(o.dropDate).toLocaleDateString())}</div>
  <table>${linesByService(o).map((g) => (g.label ? `<tr class="grp"><td colspan="2">${g.label}</td></tr>` : "") +
    g.lines.map((l) => `<tr><td>${l.qty} × ${esc(l.name)}</td><td>${money(l.qty * l.price)}</td></tr>`).join("")).join("")}
  ${discountOf(o) ? `<tr class="sub"><td>Subtotal</td><td>${money(subtotalOf(o))}</td></tr><tr class="sub"><td>Discount</td><td>−${money(discountOf(o))}</td></tr>` : ""}
  <tr class="tot"><td>Total</td><td>${money(o.total)}</td></tr>
  ${paidSoFar(o) > 0 && balanceOf(o) > 0 ? `<tr class="sub"><td>Paid so far</td><td>${money(paidSoFar(o))}</td></tr><tr class="tot"><td>Balance to pay</td><td>${money(balanceOf(o))}</td></tr>` : ""}</table>
  <div class="c">${fullyPaid(o) ? "PAID IN FULL" : paidSoFar(o) > 0 ? "PART PAID" : "NOT PAID"}</div>
  <p class="c">Thank you!</p><script>window.onload=()=>{window.print()}<\/script></body></html>`);
  w.document.close();
}

/* ================= Expenses ================= */
$("#expenseForm").onsubmit = async (e) => {
  e.preventDefault();
  const amt = num($("#eAmount").value);
  if (amt <= 0) return;
  await store.add("expenses", {
    category: $("#eCat").value,
    amount: Math.round(amt * 100) / 100,
    date: $("#eDate").value || today(),
    note: $("#eNote").value.trim(),
    createdAt: Date.now(),
    addedBy: me().name, addedByUid: me().uid,
  });
  $("#eAmount").value = ""; $("#eNote").value = "";
  toast(`Expense added · ${money(amt)}`);
};

function renderExpenses() {
  const m = today().slice(0, 7);
  const monthTotal = expenses.filter((x) => (x.date || "").startsWith(m)).reduce((s, x) => s + num(x.amount), 0);
  $("#expenseMonth").textContent = `This month: ${money(monthTotal)}`;
  const shown = expenses.slice(0, 100);
  if (!shown.length) { $("#expenseList").innerHTML = `<div class="empty">No expenses recorded yet.</div>`; return; }
  let lastDate = "";
  $("#expenseList").innerHTML = shown.map((x) => {
    const head = x.date !== lastDate ? `<div class="date-sep">${fmtDate(x.date)}</div>` : "";
    lastDate = x.date;
    return `${head}<div class="exp-row" data-id="${x.id}">
      <div><b>${esc(x.category)}</b>${x.note || x.addedBy ? `<div class="muted small">${[x.note, x.addedBy && `by ${x.addedBy}`].filter(Boolean).map(esc).join(" · ")}</div>` : ""}</div>
      <div class="row"><span class="amt">${money(x.amount)}</span>${isManager ? `<button class="icon-btn" data-del aria-label="Delete expense">✕</button>` : ""}</div>
    </div>`;
  }).join("");
}
$("#expenseList").addEventListener("click", async (e) => {
  if (!e.target.closest("[data-del]")) return;
  const id = e.target.closest(".exp-row").dataset.id;
  const x = expenses.find((y) => y.id === id);
  if (x && confirm(`Delete ${x.category} · ${money(x.amount)}?`)) { await store.remove("expenses", id); toast("Expense deleted"); }
});

/* ================= Reports ================= */
function periodRange(p) {
  const now = new Date();
  if (p === "today") return { start: today(), end: today(), label: now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) };
  if (p === "week") {
    const s = startOfWeek(now), e = addDays(s, 6);
    return { start: iso(s), end: iso(e), label: `${s.toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${e.toLocaleDateString(undefined, { day: "numeric", month: "short" })}` };
  }
  const base = p === "last-month" ? new Date(now.getFullYear(), now.getMonth() - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1);
  const e = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  return { start: iso(base), end: iso(e), label: base.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
}
const inRange = (d, r) => d && d >= r.start && d <= r.end;

function renderReports() {
  const r = periodRange(period);
  $("#periodLabel").textContent = r.label;
  const pays = allPayments().filter((p) => inRange(p.date, r));
  const income = pays.reduce((s, p) => s + num(p.amount), 0);
  const exp = expenses.filter((x) => inRange(x.date, r));
  const spent = exp.reduce((s, x) => s + num(x.amount), 0);
  const profit = income - spent;
  const dropped = orders.filter((o) => inRange(o.dropDate, r));
  const itemsIn = dropped.reduce((s, o) => s + num(o.itemCount), 0);
  const billed = dropped.reduce((s, o) => s + num(o.total), 0);
  const discounted = dropped.filter((o) => discountOf(o) > 0);
  const discTotal = discounted.reduce((s, o) => s + discountOf(o), 0);

  $("#stats").innerHTML = `
    <div class="stat"><div class="label">Money in</div><div class="value">${money(income)}</div><div class="sub">${pays.length} payment${pays.length === 1 ? "" : "s"}</div></div>
    <div class="stat"><div class="label">Expenses</div><div class="value">${money(spent)}</div><div class="sub">${exp.length} record${exp.length === 1 ? "" : "s"}</div></div>
    ${isManager
      ? `<div class="stat hero ${profit < 0 ? "neg" : ""}"><div class="label">${profit < 0 ? "Loss" : "Profit"}</div><div class="value">${money(Math.abs(profit))}</div><div class="sub">money in − expenses</div></div>`
      : `<div class="stat hero ${profit < 0 ? "neg" : ""}"><div class="label">Cash in hand</div><div class="value">${profit < 0 ? "−" : ""}${money(Math.abs(profit))}</div><div class="sub">money in − expenses today</div></div>`}
    <div class="stat"><div class="label">Orders taken</div><div class="value">${dropped.length}</div><div class="sub">${itemsIn} items · ${moneyShort(billed)} billed${discTotal ? `<br>${moneyShort(discTotal)} discount on ${discounted.length} order${discounted.length === 1 ? "" : "s"}` : ""}</div></div>`;

  // Chart: day-by-day for week / month views; "today" shows the current week.
  let days = [];
  const cr = period === "today" ? periodRange("week") : r;
  for (let d = parseISO(cr.start); iso(d) <= cr.end; d = addDays(d, 1)) days.push(iso(d));
  $("#chartTitle").textContent = period === "today" || period === "week" ? "This week by day" : `${r.label} by day`;
  const chartPays = allPayments().filter((p) => inRange(p.date, { start: days[0], end: days[days.length - 1] }));
  const data = days.map((d) => ({
    d,
    inc: chartPays.filter((p) => p.date === d).reduce((s, p) => s + num(p.amount), 0),
    exp: expenses.filter((x) => x.date === d).reduce((s, x) => s + num(x.amount), 0),
  }));
  drawChart(data);

  // Item breakdown
  const counts = {};
  dropped.forEach((o) => (o.lines || []).forEach((l) => { counts[l.name] = (counts[l.name] || 0) + l.qty; }));
  $("#itemBreakdown").innerHTML = barList(Object.entries(counts).sort((a, b) => b[1] - a[1]), (v) => `${v}`, "No items in this period.");
  const bySvc = {};
  dropped.forEach((o) => (o.lines || []).forEach((l) => { const k = svcLabel(l.service) || "Not recorded"; bySvc[k] = (bySvc[k] || 0) + l.qty; }));
  $("#serviceBreakdown").innerHTML = barList(Object.entries(bySvc).sort((a, b) => b[1] - a[1]), (v) => `${v} item${v === 1 ? "" : "s"}`, "No items in this period.");
  const cats = {};
  exp.forEach((x) => { cats[x.category] = (cats[x.category] || 0) + num(x.amount); });
  $("#expenseBreakdown").innerHTML = barList(Object.entries(cats).sort((a, b) => b[1] - a[1]), money, "No expenses in this period.", "expense");
  if (isManager) {
    const by = {};
    pays.forEach((p) => { const k = p.by || "Not recorded"; by[k] = (by[k] || 0) + num(p.amount); });
    $("#staffBreakdown").innerHTML = barList(Object.entries(by).sort((a, b) => b[1] - a[1]), money, "No payments in this period.");
  }

  // Outstanding (all time)
  const t = today();
  const notCollected = orders.filter((o) => !o.collected);
  const unpaid = orders.filter((o) => balanceOf(o) > 0);
  const paidWaiting = notCollected.filter(fullyPaid);
  const old = notCollected.filter((o) => daysBetween(o.dropDate || t, t) >= 7);
  $("#outstanding").innerHTML = `
    <button class="out" data-go="waiting"><b>${notCollected.length}</b><span>bags not collected</span></button>
    <button class="out" data-go="unpaid"><b>${money(unpaid.reduce((s, o) => s + balanceOf(o), 0))}</b><span>owed by ${unpaid.length} customer${unpaid.length === 1 ? "" : "s"}</span></button>
    <button class="out" data-go="waiting"><b>${paidWaiting.length}</b><span>paid, waiting for pickup</span></button>
    <button class="out ${old.length ? "alert" : ""}" data-go="waiting"><b>${old.length}</b><span>waiting 7+ days</span></button>`;
}

function barList(entries, fmt, emptyText, cls = "") {
  if (!entries.length) return `<div class="empty small">${emptyText}</div>`;
  const max = Math.max(...entries.map((e) => e[1]));
  return `<div class="barlist">${entries.map(([k, v]) => `
    <div class="bl-row"><span class="bl-name">${esc(k)}</span><span class="bl-track"><i class="${cls}" style="width:${Math.max(2, (v / max) * 100)}%"></i></span><span class="bl-val">${fmt(v)}</span></div>`).join("")}</div>`;
}

function drawChart(data) {
  const el = $("#chart");
  const max = Math.max(1, ...data.map((x) => Math.max(x.inc, x.exp)));
  const nice = niceMax(max);
  const W = Math.max(320, el.clientWidth || 600), H = 220, padL = 48, padB = 26, padT = 10, padR = 8;
  const iw = W - padL - padR, ih = H - padT - padB;
  const slot = iw / data.length;
  const gap = 2;
  const bw = Math.max(2, Math.min(18, (slot - 6) / 2 - gap / 2));
  const y = (v) => padT + ih - (v / nice) * ih;
  const ticks = [0, 0.5, 1].map((f) => f * nice);
  const t = today();
  const labelEvery = data.length > 10 ? Math.ceil(data.length / 8) : 1;
  const bar = (x, v, c) => {
    if (v <= 0) return "";
    const h = Math.max(1, ih - (y(v) - padT)); const r = Math.min(4, bw / 2, h);
    const top = padT + ih - h;
    return `<path class="${c}" d="M${x},${padT + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${padT + ih} Z"/>`;
  };
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Income and expenses by day">
    ${ticks.map((v) => `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`).join("")}
    ${data.map((x, i) => {
      const cx = padL + slot * i + slot / 2;
      const d = parseISO(x.d);
      const lbl = data.length <= 7 ? d.toLocaleDateString(undefined, { weekday: "short" }) : d.getDate();
      return `<g class="day ${x.d === t ? "is-today" : ""}" data-i="${i}">
        <rect class="hit" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${ih}"/>
        ${bar(cx - bw - gap / 2, x.inc, "income")}${bar(cx + gap / 2, x.exp, "expense")}
        ${i % labelEvery === 0 || x.d === t ? `<text class="axis ${x.d === t ? "today" : ""}" x="${cx}" y="${H - 8}" text-anchor="middle">${lbl}</text>` : ""}
      </g>`;
    }).join("")}
  </svg><div class="tip" hidden></div>`;
  const tip = $(".tip", el);
  $$("g.day", el).forEach((g) => {
    const showTip = () => {
      const x = data[+g.dataset.i];
      tip.innerHTML = `<b>${parseISO(x.d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</b>
        <div><i class="sw income"></i>Income <span>${money(x.inc)}</span></div>
        <div><i class="sw expense"></i>Expenses <span>${money(x.exp)}</span></div>
        <div class="tip-net">Net <span>${money(x.inc - x.exp)}</span></div>`;
      tip.hidden = false;
      const box = g.getBoundingClientRect(), host = el.getBoundingClientRect();
      let left = box.left - host.left + box.width / 2 - tip.offsetWidth / 2;
      left = Math.max(0, Math.min(host.width - tip.offsetWidth, left));
      tip.style.left = `${left}px`;
      $$("g.day", el).forEach((o) => o.classList.toggle("hover", o === g));
    };
    g.addEventListener("mouseenter", showTip);
    g.addEventListener("click", showTip);
  });
  el.onmouseleave = () => { tip.hidden = true; $$("g.day", el).forEach((o) => o.classList.remove("hover")); };
}
const niceMax = (v) => { const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
const compact = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);

$("#periodChips").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  period = b.dataset.p;
  $$("#periodChips button").forEach((x) => x.classList.toggle("active", x === b));
  renderReports();
});
$("#outstanding").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]"); if (!b) return;
  orderFilter = b.dataset.go; $("#search").value = "";
  $$("#orderFilters button").forEach((x) => x.classList.toggle("active", x.dataset.f === orderFilter));
  renderOrders(); show("orders");
});
let rT; window.addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(() => { if (!$("#view-reports").hidden) renderReports(); }, 150); });
$$("#tabs button").forEach((b) => b.addEventListener("click", () => { if (b.dataset.view === "reports") renderReports(); }));

/* ================= CSV export ================= */
$("#exportCsv").onclick = () => {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["Type", "Ticket", "Customer", "Phone", "Drop-off", "Items", "Subtotal", "Discount", "Total", "Paid so far", "Balance", "Paid in full on", "Collected on", "Category", "Amount", "Date", "Note"]];
  orders.forEach((o) => rows.push(["Order", o.ticket, o.customer, o.phone, o.dropDate, (o.lines || []).map((l) => `${l.qty} ${l.name}${l.service ? ` (${svcLabel(l.service)})` : ""}`).join("; "), subtotalOf(o), discountOf(o), o.total, paidSoFar(o), balanceOf(o), fullyPaid(o) ? o.paidOn || "" : "", o.collectedOn || "", "", "", "", o.note]));
  expenses.forEach((x) => rows.push(["Expense", "", "", "", "", "", "", "", "", "", "", "", "", x.category, x.amount, x.date, x.note]));
  const blob = new Blob([rows.map((r) => r.map(q).join(",")).join("\n")], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `laundry-${today()}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
};

/* ================= Staff (manager only) ================= */
function renderStaff() {
  if (!isManager) return;
  const t = today();
  const isOwner = (m) => m.owner || m.id === profile.shopId;
  const rows = [...members].sort((a, b) => (a.role === b.role ? (a.name || "").localeCompare(b.name || "") : a.role === "manager" ? -1 : 1));
  const html = rows.map((m) => {
    const takenToday = allPayments().filter((p) => p.byUid === m.id && p.date === t).reduce((s, p) => s + num(p.amount), 0);
    const self = m.id === currentUser.uid;
    return `<div class="member" data-uid="${esc(m.id)}">
      <div class="avatar">${esc((m.name || m.email || "?").trim()[0] || "?").toUpperCase()}</div>
      <div class="member-info"><b>${esc(m.name || m.email)}${self ? ' <span class="muted">(you)</span>' : ""}</b>
        <div class="muted small">${esc(m.email || "")}${takenToday ? ` · took ${money(takenToday)} today` : ""}</div></div>
      ${isOwner(m) || self
        ? `<span class="role-tag ${m.role}">${m.role === "manager" ? "Manager" : "Staff"}${isOwner(m) ? " · owner" : ""}</span>`
        : `<select class="role-select" aria-label="Role for ${esc(m.name)}"><option value="staff" ${m.role === "staff" ? "selected" : ""}>Shop staff</option><option value="manager" ${m.role === "manager" ? "selected" : ""}>Manager</option></select>
           <button class="icon-btn" data-remove title="Remove" aria-label="Remove ${esc(m.name)}">✕</button>`}
    </div>`;
  }).join("");
  const inv = invites.map((i) => `<div class="member pending" data-email="${esc(i.id)}">
      <div class="avatar">?</div>
      <div class="member-info"><b>${esc(i.name || i.id)}</b><div class="muted small">${esc(i.id)} · waiting for them to sign up</div></div>
      <span class="role-tag ${i.role}">${i.role === "manager" ? "Manager" : "Staff"}</span>
      <button class="icon-btn" data-cancel title="Cancel invite" aria-label="Cancel invite">✕</button>
    </div>`).join("");
  $("#memberList").innerHTML = html + inv || `<div class="empty small">Only you so far.</div>`;
}
$("#memberList").addEventListener("change", async (e) => {
  if (!e.target.matches(".role-select")) return;
  const uid = e.target.closest(".member").dataset.uid;
  const m = members.find((x) => x.id === uid);
  try { await store.updateMember(uid, { role: e.target.value }); toast(`${m?.name} is now ${e.target.value === "manager" ? "a manager" : "shop staff"}`); }
  catch (ex) { console.error(ex); toast("Could not change role"); renderStaff(); }
});
$("#memberList").addEventListener("click", async (e) => {
  const row = e.target.closest(".member"); if (!row) return;
  if (e.target.closest("[data-remove]")) {
    const m = members.find((x) => x.id === row.dataset.uid);
    if (!confirm(`Remove ${m?.name} from the shop? They will no longer be able to use the app.`)) return;
    try { await store.removeMember(row.dataset.uid); toast("Removed"); } catch (ex) { console.error(ex); toast("Could not remove"); }
  }
  if (e.target.closest("[data-cancel]")) {
    try { await store.cancelInvite(row.dataset.email); toast("Invite cancelled"); } catch (ex) { console.error(ex); toast("Could not cancel"); }
  }
});
$("#inviteForm").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("#invEmail").value.trim().toLowerCase(), name = $("#invName").value.trim(), role = $("#invRole").value;
  if (members.some((m) => (m.email || "").toLowerCase() === email)) return toast("That person is already on the staff list");
  const btn = $("#inviteForm button[type=submit]"); btn.disabled = true;
  try {
    await store.inviteStaff(email, name, role);
    $("#inviteForm").reset();
    toast(`${name} added. They can now create an account with ${email}`);
  } catch (ex) { console.error(ex); toast("Could not add. Check your internet connection."); }
  finally { btn.disabled = false; }
};

/* ================= Render ================= */
function renderAll() {
  if (!currentUser) return;
  renderOrders();
  renderExpenses();
  if (!$("#view-reports").hidden) renderReports();
  if (isManager) renderStaff();
  if (!editingId) $("#orderTicket").textContent = `Ticket ${ticketStr(nextTicket())}`;
  const names = [...new Set(orders.map((o) => o.customer).filter(Boolean))].slice(0, 300);
  $("#customerList").innerHTML = names.map((n) => `<option value="${esc(n)}">`).join("");
}

$("#eDate").value = today();
// Keep "today" correct if the app stays open past midnight
setInterval(() => { if ($("#eDate").value < today() && !document.activeElement?.closest("#expenseForm")) $("#eDate").value = today(); }, 60000);

boot();
