import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, collection, getDocs } from "firebase/firestore";
import { readFileSync } from "node:fs";

const env = await initializeTestEnvironment({
  projectId: "laundry-test",
  firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8085 },
});

const M = "mgr1", S = "staff1", X = "stranger";
const mgr = env.authenticatedContext(M, { email: "boss@x.com" }).firestore();
const staff = env.authenticatedContext(S, { email: "akosua@x.com" }).firestore();
const stranger = env.authenticatedContext(X, { email: "evil@x.com" }).firestore();

let pass = 0, fail = 0;
async function t(name, p) { try { await p; pass++; console.log("  ok  ", name); } catch (e) { fail++; console.log("  FAIL", name, e.message?.slice(0, 120)); } }

const order = { ticket: 1, customer: "Kofi", total: 50, paid: false, paidOn: null, collected: false, collectedOn: null, lines: [] };

// Manager sets up shop
{
  const b = writeBatch(mgr);
  b.set(doc(mgr, "shops", M), { ownerUid: M, settings: { shopName: "Shop" } });
  b.set(doc(mgr, "shops", M, "members", M), { role: "manager", name: "Kwame", email: "boss@x.com" });
  b.set(doc(mgr, "users", M), { shopId: M });
  await t("manager creates shop", assertSucceeds(b.commit()));
}
await t("stranger cannot create a shop under someone else's id", assertFails(setDoc(doc(stranger, "shops", M + "x"), { ownerUid: M + "x" })));
await t("stranger cannot read shop", assertFails(getDoc(doc(stranger, "shops", M))));
await t("stranger cannot make themselves a member", assertFails(setDoc(doc(stranger, "shops", M, "members", X), { role: "staff" })));

// Invite staff
{
  const b = writeBatch(mgr);
  b.set(doc(mgr, "invites", "akosua@x.com"), { shopId: M, role: "staff", name: "Akosua" });
  b.set(doc(mgr, "shops", M, "invites", "akosua@x.com"), { role: "staff", name: "Akosua" });
  await t("manager invites staff", assertSucceeds(b.commit()));
}
await t("stranger cannot read someone else's invite", assertFails(getDoc(doc(stranger, "invites", "akosua@x.com"))));
await t("stranger cannot create an invite for a shop", assertFails(setDoc(doc(stranger, "invites", "evil@x.com"), { shopId: M, role: "manager" })));
await t("staff reads own invite", assertSucceeds(getDoc(doc(staff, "invites", "akosua@x.com"))));
await t("staff cannot accept invite as manager", assertFails(setDoc(doc(staff, "shops", M, "members", S), { role: "manager", name: "A" })));
await t("staff accepts invite as staff", assertSucceeds(setDoc(doc(staff, "shops", M, "members", S), { role: "staff", name: "Akosua", email: "akosua@x.com" })));
await t("staff writes user pointer", assertSucceeds(setDoc(doc(staff, "users", S), { shopId: M })));
await t("staff deletes own invite", assertSucceeds(deleteDoc(doc(staff, "invites", "akosua@x.com"))));
await t("staff deletes shop-side invite", assertSucceeds(deleteDoc(doc(staff, "shops", M, "invites", "akosua@x.com"))));
await t("staff cannot promote self", assertFails(updateDoc(doc(staff, "shops", M, "members", S), { role: "manager" })));

// Orders
await t("staff creates order", assertSucceeds(setDoc(doc(staff, "shops", M, "orders", "o1"), order)));
await t("staff reads orders", assertSucceeds(getDocs(collection(staff, "shops", M, "orders"))));
await t("stranger cannot read orders", assertFails(getDocs(collection(stranger, "shops", M, "orders"))));
await t("staff cannot change total", assertFails(updateDoc(doc(staff, "shops", M, "orders", "o1"), { total: 10 })));
await t("staff marks paid", assertSucceeds(updateDoc(doc(staff, "shops", M, "orders", "o1"), { paid: true, paidOn: "2026-11-17", paidBy: "Akosua", paidByUid: S })));
await t("staff cannot undo paid", assertFails(updateDoc(doc(staff, "shops", M, "orders", "o1"), { paid: false, paidOn: null })));
await t("staff marks collected", assertSucceeds(updateDoc(doc(staff, "shops", M, "orders", "o1"), { collected: true, collectedOn: "2026-11-17", collectedBy: "Akosua" })));
await t("staff cannot undo collected", assertFails(updateDoc(doc(staff, "shops", M, "orders", "o1"), { collected: false })));
await t("staff cannot delete order", assertFails(deleteDoc(doc(staff, "shops", M, "orders", "o1"))));
await t("manager undoes paid", assertSucceeds(updateDoc(doc(mgr, "shops", M, "orders", "o1"), { paid: false, paidOn: null })));
await t("manager edits total", assertSucceeds(updateDoc(doc(mgr, "shops", M, "orders", "o1"), { total: 60 })));
await t("manager deletes order", assertSucceeds(deleteDoc(doc(mgr, "shops", M, "orders", "o1"))));

// Discounts
const disc = { ...order, subtotal: 100, discount: 20, total: 80 };
await t("staff creates order with 20 off 100", assertSucceeds(setDoc(doc(staff, "shops", M, "orders", "d1"), disc)));
await t("discount bigger than the bill is refused", assertFails(setDoc(doc(staff, "shops", M, "orders", "d2"), { ...disc, discount: 150 })));
await t("negative discount is refused", assertFails(setDoc(doc(staff, "shops", M, "orders", "d3"), { ...disc, discount: -5 })));
await t("staff cannot change a discount later", assertFails(updateDoc(doc(staff, "shops", M, "orders", "d1"), { discount: 50, total: 50 })));
await t("staff can still mark a discounted order paid", assertSucceeds(updateDoc(doc(staff, "shops", M, "orders", "d1"), { paid: true, paidOn: "2026-11-22" })));
await t("manager can change a discount", assertSucceeds(updateDoc(doc(mgr, "shops", M, "orders", "d1"), { discount: 10, total: 90 })));
await t("manager cannot set discount above bill", assertFails(updateDoc(doc(mgr, "shops", M, "orders", "d1"), { discount: 120 })));

// Part payments
const po = { ...order, subtotal: 100, discount: 0, total: 100, payments: [] };
const p1 = { amount: 50, date: "2026-11-20", by: "Akosua", byUid: S };
const p2 = { amount: 50, date: "2026-11-22", by: "Akosua", byUid: S };
await t("staff creates order with no payment", assertSucceeds(setDoc(doc(staff, "shops", M, "orders", "p1"), po)));
await t("staff adds a part payment", assertSucceeds(updateDoc(doc(staff, "shops", M, "orders", "p1"), { payments: [p1] })));
await t("staff cannot change an earlier payment", assertFails(updateDoc(doc(staff, "shops", M, "orders", "p1"), { payments: [{ ...p1, amount: 10 }] })));
await t("staff cannot remove a payment", assertFails(updateDoc(doc(staff, "shops", M, "orders", "p1"), { payments: [] })));
await t("staff cannot add two payments at once", assertFails(updateDoc(doc(staff, "shops", M, "orders", "p1"), { payments: [p1, p2, p2] })));
await t("staff cannot add a zero payment", assertFails(updateDoc(doc(staff, "shops", M, "orders", "p1"), { payments: [p1, { ...p2, amount: 0 }] })));
await t("staff cannot add a payment bigger than the bill", assertFails(updateDoc(doc(staff, "shops", M, "orders", "p1"), { payments: [p1, { ...p2, amount: 500 }] })));
await t("staff pays the balance and marks paid", assertSucceeds(updateDoc(doc(staff, "shops", M, "orders", "p1"), { payments: [p1, p2], paid: true, paidOn: "2026-11-22", paidBy: "Akosua", paidByUid: S })));
await t("manager removes last payment", assertSucceeds(updateDoc(doc(mgr, "shops", M, "orders", "p1"), { payments: [p1], paid: false, paidOn: null })));
await t("staff adds first payment to an older order with no payment list", assertSucceeds(updateDoc(doc(staff, "shops", M, "orders", "d1"), { payments: [p1] })));

// Expenses
await t("staff adds expense", assertSucceeds(setDoc(doc(staff, "shops", M, "expenses", "e1"), { amount: 20, category: "Soap" })));
await t("staff cannot edit expense", assertFails(updateDoc(doc(staff, "shops", M, "expenses", "e1"), { amount: 2 })));
await t("staff cannot delete expense", assertFails(deleteDoc(doc(staff, "shops", M, "expenses", "e1"))));
await t("manager deletes expense", assertSucceeds(deleteDoc(doc(mgr, "shops", M, "expenses", "e1"))));

// Settings / members
await t("staff reads shop settings", assertSucceeds(getDoc(doc(staff, "shops", M))));
await t("staff cannot change prices", assertFails(updateDoc(doc(staff, "shops", M), { settings: { shopName: "x" } })));
await t("manager changes prices", assertSucceeds(updateDoc(doc(mgr, "shops", M), { settings: { shopName: "y" } })));
await t("staff cannot read invites list", assertFails(getDocs(collection(staff, "shops", M, "invites"))));
await t("staff cannot remove the owner", assertFails(deleteDoc(doc(staff, "shops", M, "members", M))));
await t("manager promotes staff", assertSucceeds(updateDoc(doc(mgr, "shops", M, "members", S), { role: "manager" })));
await t("promoted manager cannot remove the owner", assertFails(deleteDoc(doc(staff, "shops", M, "members", M))));
await t("manager removes staff", assertSucceeds(deleteDoc(doc(mgr, "shops", M, "members", S))));
await t("removed staff can't read orders", assertFails(getDocs(collection(staff, "shops", M, "orders"))));
await t("removed staff can't create orders", assertFails(setDoc(doc(staff, "shops", M, "orders", "o2"), order)));
await t("removed staff can check own member doc (gets 'not found')", assertSucceeds(getDoc(doc(staff, "shops", M, "members", S))));

console.log(`\n${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
