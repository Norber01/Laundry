// Data layer. Uses Firebase (Auth + Firestore) when firebase-config.js is filled in,
// otherwise a demo store that keeps everything in this browser's localStorage.
//
// Firestore layout:
//   shops/{shopId}                     { ownerUid, settings }        shopId = manager's uid
//   shops/{shopId}/members/{uid}       { role: "manager"|"staff", name, email }
//   shops/{shopId}/invites/{email}     { role, name }                pending staff invites (for the manager's list)
//   shops/{shopId}/orders/{id}
//   shops/{shopId}/expenses/{id}
//   invites/{email}                    { shopId, role, name }        lookup used when staff first sign in
//   users/{uid}                        { shopId }
import { firebaseConfig } from "./firebase-config.js";

const FB = "https://www.gstatic.com/firebasejs/10.14.1";
export const isDemo = !firebaseConfig || !firebaseConfig.apiKey;

/* ---------------- Demo (local) store ---------------- */
function createLocalStore() {
  const KEY = "laundry-demo-v1";
  const ROLE_KEY = "laundry-demo-role";
  const names = { manager: "Kwame", staff: "Akosua" };
  const listeners = { orders: new Set(), expenses: new Set(), settings: new Set(), members: new Set(), invites: new Set() };
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { db = {}; }
  db.orders ||= {}; db.expenses ||= {}; db.settings ||= null; db.invites ||= {};
  db.members ||= {
    "demo-manager": { role: "manager", name: names.manager, email: "manager@demo", owner: true },
    "demo-staff": { role: "staff", name: names.staff, email: "akosua@demo" },
  };
  let role = "manager";
  try { role = localStorage.getItem(ROLE_KEY) || "manager"; } catch {}

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  const emit = (name) => {
    const v = db[name];
    const val = name === "settings" ? v : Object.entries(v).map(([id, d]) => ({ id, ...d }));
    listeners[name].forEach((cb) => cb(val));
  };
  const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  let authCb = null;
  const user = () => ({ uid: role === "manager" ? "demo-manager" : "demo-staff", email: role === "manager" ? "manager@demo" : "akosua@demo", displayName: names[role] });

  return {
    mode: "demo",
    onAuth(cb) { authCb = cb; setTimeout(() => cb(user()), 0); return () => {}; },
    async signIn() {}, async signUp() {}, async resetPassword() {}, async signOut() {},
    async loadProfile() { return { status: "ok", shopId: "demo", role, name: names[role], owner: role === "manager" }; },
    async createShop() {},
    // Demo only: switch between the manager and staff sides.
    switchRole(r) { role = r; try { localStorage.setItem(ROLE_KEY, r); } catch {} authCb?.(user()); },
    watch(name, cb) { listeners[name].add(cb); setTimeout(() => emit(name), 0); return () => listeners[name].delete(cb); },
    async add(name, data) { const k = id(); db[name][k] = data; save(); emit(name); return k; },
    async update(name, k, patch) { db[name][k] = { ...db[name][k], ...patch }; save(); emit(name); },
    async remove(name, k) { delete db[name][k]; save(); emit(name); },
    async saveSettings(s) { db.settings = s; save(); emit("settings"); },
    async inviteStaff(email, name, r) { db.invites[email] = { name, role: r }; save(); emit("invites"); },
    async cancelInvite(email) { delete db.invites[email]; save(); emit("invites"); },
    async updateMember(uid, patch) { db.members[uid] = { ...db.members[uid], ...patch }; save(); emit("members"); },
    async removeMember(uid) { delete db.members[uid]; save(); emit("members"); },
  };
}

/* ---------------- Firebase store ---------------- */
async function createFirebaseStore() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const a = auth.getAuth(app);
  let db;
  try {
    // Works offline: changes are saved on the device and synced when internet returns.
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app);
  }
  let shopId = null;
  const offlineError = (e) => ["unavailable", "deadline-exceeded"].includes(e?.code) || e?.message === "timeout" || !navigator.onLine;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  async function lookUpShop(uid) {
    const u = await fs.getDoc(fs.doc(db, "users", uid));
    if (!u.exists()) return { status: "new" };
    const sid = u.data().shopId;
    let m;
    try { m = await fs.getDoc(fs.doc(db, "shops", sid, "members", uid)); }
    catch (e) { if (offlineError(e)) throw e; return { status: "removed" }; }
    if (!m.exists()) return { status: "removed" };
    shopId = sid;
    return { status: "ok", shopId: sid, role: m.data().role, name: m.data().name, owner: sid === uid };
  }
  const shopRef = () => fs.doc(db, "shops", shopId);
  const col = (name) => fs.collection(db, "shops", shopId, name);
  const emailOf = (u) => (u.email || "").trim().toLowerCase();

  return {
    mode: "firebase",
    onAuth: (cb) => auth.onAuthStateChanged(a, cb),
    signIn: (e, p) => auth.signInWithEmailAndPassword(a, e, p),
    async signUp(e, p, name) {
      const cred = await auth.createUserWithEmailAndPassword(a, e, p);
      if (name) await auth.updateProfile(cred.user, { displayName: name });
    },
    resetPassword: (e) => auth.sendPasswordResetEmail(a, e),
    signOut: () => { shopId = null; return auth.signOut(a); },

    // Works out which shop this person belongs to and their role.
    async loadProfile(user) {
      const uid = user.uid, email = emailOf(user);
      // 1) Accept a pending invite, if the manager added this email.
      try {
        const inv = await fs.getDoc(fs.doc(db, "invites", email));
        if (inv.exists()) {
          const { shopId: sid, role, name } = inv.data();
          await fs.setDoc(fs.doc(db, "shops", sid, "members", uid), { role, name: name || user.displayName || email, email, joinedAt: Date.now() });
          await fs.setDoc(fs.doc(db, "users", uid), { shopId: sid });
          await Promise.all([fs.deleteDoc(inv.ref), fs.deleteDoc(fs.doc(db, "shops", sid, "invites", email))]).catch(() => {});
        }
      } catch (e) { console.warn("invite check", e); }
      // 2) Look up the shop this account belongs to. With no (or very slow) internet, use the
      //    shop and role saved on this phone the last time it was online.
      const savedKey = `laundry-profile-${uid}`;
      let hasSaved = false;
      try { hasSaved = !!localStorage.getItem(savedKey); } catch {}
      try {
        // Only give up on a slow connection when there is a saved copy to fall back to.
        const p = await (hasSaved ? withTimeout(lookUpShop(uid), 8000) : lookUpShop(uid));
        if (p.status === "ok") { try { localStorage.setItem(savedKey, JSON.stringify(p)); } catch {} }
        else { try { localStorage.removeItem(savedKey); } catch {} }
        return p;
      } catch (e) {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(savedKey)); } catch {}
        if (saved?.status === "ok") { shopId = saved.shopId; return { ...saved, fromSaved: true }; }
        throw e;
      }
    },

    // The first person to set up a shop becomes its manager.
    async createShop(user, shopName, yourName, defaults) {
      const uid = user.uid;
      const b = fs.writeBatch(db);
      b.set(fs.doc(db, "shops", uid), { ownerUid: uid, settings: { ...defaults, shopName }, createdAt: Date.now() });
      b.set(fs.doc(db, "shops", uid, "members", uid), { role: "manager", name: yourName, email: emailOf(user), joinedAt: Date.now() });
      b.set(fs.doc(db, "users", uid), { shopId: uid });
      await b.commit();
      if (yourName && !user.displayName) auth.updateProfile(user, { displayName: yourName }).catch(() => {});
    },

    watch(name, cb) {
      const err = (e) => console.warn(`watch ${name}`, e);
      if (name === "settings") return fs.onSnapshot(shopRef(), (s) => cb(s.exists() ? s.data().settings || null : null), err);
      return fs.onSnapshot(col(name), (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), err);
    },
    async add(name, data) {
      const ref = fs.doc(col(name));
      fs.setDoc(ref, data).catch((e) => alertErr(e)); // don't await: resolves only once the server confirms
      return ref.id;
    },
    async update(name, k, patch) { fs.updateDoc(fs.doc(col(name), k), patch).catch((e) => alertErr(e)); },
    async remove(name, k) { fs.deleteDoc(fs.doc(col(name), k)).catch((e) => alertErr(e)); },
    async saveSettings(s) { fs.updateDoc(shopRef(), { settings: s }).catch((e) => alertErr(e)); },

    async inviteStaff(email, name, role) {
      email = email.trim().toLowerCase();
      const b = fs.writeBatch(db);
      b.set(fs.doc(db, "invites", email), { shopId, role, name, createdAt: Date.now() });
      b.set(fs.doc(db, "shops", shopId, "invites", email), { role, name, createdAt: Date.now() });
      await b.commit();
    },
    async cancelInvite(email) {
      const b = fs.writeBatch(db);
      b.delete(fs.doc(db, "invites", email));
      b.delete(fs.doc(db, "shops", shopId, "invites", email));
      await b.commit();
    },
    updateMember: (uid, patch) => fs.updateDoc(fs.doc(db, "shops", shopId, "members", uid), patch),
    removeMember: (uid) => fs.deleteDoc(fs.doc(db, "shops", shopId, "members", uid)),
  };
}

function alertErr(e) {
  console.error(e);
  if (String(e?.code).includes("permission")) alert("You don't have permission to do that. Ask the manager.");
}

export async function createStore() {
  return isDemo ? createLocalStore() : createFirebaseStore();
}
