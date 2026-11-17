# Laundry Book

A simple laundry shop manager that runs on Firebase. It works on phones and computers and keeps working offline.

- **New order**: type the customer's name, tap **+** for each item (shirts, trousers, jeans, bedsheets, pillowcases, duvets, singlets, boxers). The bill totals itself. Each order gets a ticket number (#001, #002…) to write on the bag.
- **Orders**: every order shows **Paid on [date] / Not paid** and **Collected / Not collected yet (n days)**. Tap *Mark paid* or *Mark collected* and pick the date. You can filter by Not collected, Not paid, Today, Collected or All, or search by name, phone or ticket. You can also send the receipt on WhatsApp or print it.
- **Expenses**: log soap, detergent, electricity, water and so on.
- **Reports**: Today, This week, This month and Last month. Each shows money in, expenses, profit, a day-by-day income vs expenses chart, items washed, and how much is still owed or waiting for pickup.
- **Settings**: shop name, currency, price list (add or remove item types) and expense types. Changing a price only affects new orders. You can also export everything to CSV.

"Money in" counts an order on the day it was **paid**, not the day it was dropped off.

## Try it right away (demo mode)

While `public/firebase-config.js` is empty, the app runs in demo mode and saves data in that browser only.

```bash
cd public && python3 -m http.server 8080   # then open http://localhost:8080
```

## Put it on Firebase

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

Open the hosting URL, tap **New shop? Create an account**, and sign in on every phone the shop uses with that same account. All of them will share the same orders.

## Data layout

```
users/{uid}/settings/main     shop name, currency, price list, expense types
users/{uid}/orders/{id}       ticket, customer, phone, dropDate, lines[{name, price, qty}], total,
                              paid, paidOn, collected, collectedOn, note
users/{uid}/expenses/{id}     category, amount, date, note
```

`firestore.rules` lets each account read and write only its own data.
