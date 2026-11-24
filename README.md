# Laundry Book

A simple laundry shop manager that runs on Firebase. It works on phones and computers and keeps working offline.

- **New order**: type the customer's name, tap **+** for each item (shirts, trousers, jeans, bedsheets, pillowcases, duvets, singlets, boxers). The bill totals itself. Each order gets a ticket number (#001, #002…) to write on the bag.
- **Orders**: every order shows **Paid on [date] / Not paid** and **Collected / Not collected yet (n days)**. Tap *Mark paid* or *Mark collected* and pick the date. You can filter by Not collected, Not paid, Today, Collected or All, or search by name, phone or ticket. You can also send the receipt on WhatsApp or print it.
- **Expenses**: log soap, detergent, electricity, water and so on.
- **Reports**: Today, This week, This month and Last month. Each shows money in, expenses, profit, a day-by-day income vs expenses chart, items washed, and how much is still owed or waiting for pickup.
- **Settings**: shop name, currency, price list (add or remove item types) and expense types. Changing a price only affects new orders. You can also export everything to CSV.

**Services:** each order line is *Wash & iron*, *Wash only* or *Iron only*. At the top of the item list, tap the service, then count the items. One order can mix services (for example shirts to wash and iron, and dresses to iron only). Each item has its own price for each service in **Settings → Price list**; leave a box empty if the shop doesn't offer that service for the item. Price lists saved before services existed keep their old price for Wash & iron and Wash only, and Iron only stays off until the manager sets those prices. Order cards, receipts and reports show the service.

**Discounts:** type an amount in the *Discount* box on a new order (for example 20 off a 100 bill). The customer pays 80. The order card, the WhatsApp receipt and the printed receipt show the subtotal, the discount and the total. Reports show the total discount given. Only the manager can change a discount after the order is saved.

**Part payments:** on a new order, type what the customer pays now in *Amount paid now* (or tap *Paid in full* / *Not paid*). An order that still has money owing shows **Owes GH₵ …** and a **Take balance** button. Tap it when the customer brings the rest. An order can take any number of payments, and the ⋯ menu lists each one with its date and who took it. The **Owing** filter lists everyone with a balance. Receipts show *Paid so far* and *Balance to pay*. Staff can add payments but can't remove or change one; the manager can *Undo last payment*.

"Money in" counts each payment on the day it was **received**, not the day the clothes were dropped off. So GH₵ 60 paid on Monday and the GH₵ 40 balance paid on Friday show up on those two days.

## Works without data

After the app has opened once with internet on a phone, it saves itself there (`public/sw.js`) and opens even with no data, from the browser or the home-screen icon. Orders, payments and expenses entered offline are kept on the phone and sync automatically when data comes back. A dark *Offline* bar shows while there's no connection. Signing in for the first time on a phone needs data.

## Manager and shop staff

Each person has their own login and one of two roles.

| | Shop staff | Manager |
|---|:-:|:-:|
| Take new orders | ✓ | ✓ |
| Mark paid / collected, send receipts | ✓ | ✓ |
| Add expenses | ✓ | ✓ |
| "Today" screen: money in, expenses, cash in hand | ✓ | ✓ |
| Weekly / monthly reports and profit | | ✓ |
| Edit or delete orders, undo a payment | | ✓ |
| Delete expenses | | ✓ |
| Change prices and shop settings | | ✓ |
| Add / remove staff | | ✓ |

Every order records **who took it, who marked it paid and who marked it collected**, and every expense records who added it. Reports has a "Payments taken by" breakdown so the manager can match cash to each person.

These limits are enforced by the Firestore security rules (`firestore.rules`), not just hidden in the app.

**Adding staff:** the manager opens **Settings → Staff**, enters the person's name and email, and taps **Add person**. The staff member opens the app, taps **First time? Create an account** with that same email, and they're in. To remove someone, tap ✕ next to their name. They lose access immediately.

## Try it right away (demo mode)

While `public/firebase-config.js` is empty, the app runs in demo mode and saves data in that browser only. A switch at the top lets you try both the **Manager** and **Shop staff** sides.

```bash
cd public && python3 -m http.server 8080   # then open http://localhost:8080
```

## Publish from a phone (no computer needed)

The app is published by GitHub Pages (see `.github/workflows/pages.yml`). Firebase only provides login and the database.

1. **Firebase console** (console.firebase.google.com): create a project, then:
   - Authentication → Get started → Email/Password → Enable.
   - Firestore Database → Create database → production mode.
   - Firestore Database → **Rules** tab → replace everything with the contents of `firestore.rules` → Publish.
   - Project settings → Your apps → Web (`</>`) → register → copy the config into `public/firebase-config.js`.
2. **GitHub**: Settings → Pages → Source: **GitHub Actions**.
3. Push or merge to `main`. The app appears at `https://<user>.github.io/Laundry/` a minute later.

## Put it on Firebase Hosting (from a computer)

1. In the [Firebase console](https://console.firebase.google.com), create a project.
2. **Build → Authentication → Get started** and enable **Email/Password**.
3. **Build → Firestore Database → Create database** (production mode).
4. **Project settings → Your apps → Web app (</>)**. Copy the config into `public/firebase-config.js`.
5. Put your project ID in `.firebaserc`, then deploy:

```bash
npm install -g firebase-tools
firebase login
firebase deploy
```

Open the hosting URL. The manager taps **First time? Create an account**, then **I'm the manager: set up my shop**. Then add each staff member under **Settings → Staff**.

## Data layout

```
shops/{shopId}                  ownerUid, settings (shop name, currency, price list, expense types)
shops/{shopId}/members/{uid}    role ("manager" | "staff"), name, email
shops/{shopId}/invites/{email}  pending staff invites
shops/{shopId}/orders/{id}      ticket, customer, phone, dropDate, lines[{name, price, qty}], total,
                                paid, paidOn, paidBy, collected, collectedOn, collectedBy, createdBy, note
shops/{shopId}/expenses/{id}    category, amount, date, note, addedBy
invites/{email}                 shopId, role (looked up when a new staff member first signs in)
users/{uid}                     shopId
```

## Testing the security rules

```bash
npm install
npm run test:rules     # starts the Firestore emulator (needs Java) and runs 48 permission checks
```
