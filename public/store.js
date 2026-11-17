// Data layer. Uses Firebase (Auth + Firestore) when firebase-config.js is filled in,
// otherwise a demo store that keeps everything in this browser's localStorage.
import { firebaseConfig } from "./firebase-config.js";

const FB = "https://www.gstatic.com/firebasejs/10.14.1";
export const isDemo = !firebaseConfig || !firebaseConfig.apiKey;

/* ---------------- Demo (local) store ---------------- */
function createLocalStore() {
  const KEY = "laundry-demo-v1";
  const listeners = { orders: new Set(), expenses: new Set(), settings: new Set() };
  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { db = {}; }
  db.orders ||= {}; db.expenses ||= {}; db.settings ||= null;

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
  const emit = (name) => {
    const val = name === "settings" ? db.settings : Object.entries(db[name]).map(([id, d]) => ({ id, ...d }));
    listeners[name].forEach((cb) => cb(val));
  };
  const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  return {
    mode: "demo",
    onAuth(cb) { setTimeout(() => cb({ uid: "demo", email: "Demo mode (this device only)" }), 0); return () => {}; },
    async signIn() {}, async signUp() {}, async resetPassword() {}, async signOut() {},
    watch(name, cb) { listeners[name].add(cb); setTimeout(() => emit(name), 0); return () => listeners[name].delete(cb); },
    async add(name, data) { const k = id(); db[name][k] = data; save(); emit(name); return k; },
    async update(name, k, patch) { db[name][k] = { ...db[name][k], ...patch }; save(); emit(name); },
    async remove(name, k) { delete db[name][k]; save(); emit(name); },
    async saveSettings(s) { db.settings = s; save(); emit("settings"); },
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
  const uid = () => a.currentUser.uid;
  const col = (name) => fs.collection(db, "users", uid(), name);
  const settingsDoc = () => fs.doc(db, "users", uid(), "settings", "main");

  return {
    mode: "firebase",
    onAuth: (cb) => auth.onAuthStateChanged(a, cb),
    signIn: (e, p) => auth.signInWithEmailAndPassword(a, e, p),
    signUp: (e, p) => auth.createUserWithEmailAndPassword(a, e, p),
    resetPassword: (e) => auth.sendPasswordResetEmail(a, e),
    signOut: () => auth.signOut(a),
    watch(name, cb) {
      if (name === "settings") {
        return fs.onSnapshot(settingsDoc(), (snap) => cb(snap.exists() ? snap.data() : null));
      }
      return fs.onSnapshot(col(name), (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    },
    async add(name, data) {
      const ref = fs.doc(col(name));
      fs.setDoc(ref, data); // don't await: resolves only once the server confirms
      return ref.id;
    },
    async update(name, k, patch) { fs.updateDoc(fs.doc(col(name), k), patch); },
    async remove(name, k) { fs.deleteDoc(fs.doc(col(name), k)); },
    async saveSettings(s) { fs.setDoc(settingsDoc(), s); },
  };
}

export async function createStore() {
  return isDemo ? createLocalStore() : createFirebaseStore();
}
