# Dragonwall

Co-op dragon survival on a mountaintop castle. Waves of dragons, nine unlockable medieval weapons, and a gem store for powerful perks.

Two parts:
- `index.html` is the game. Host it on GitHub Pages.
- `server/` is the payment backend (Node, Stripe, SQLite). Host it anywhere that runs Node.

With `API` left empty in `index.html`, the game runs with a free demo store and no backend.

## 1. Deploy the game (GitHub Pages)
Upload `index.html` to a repo, then Settings → Pages → Deploy from branch → `main` / root.
Keep `server/` in a separate repo if you can, so Pages doesn't publish it.

## 2. Set up Stripe
1. Create a Stripe account and stay in **test mode** until everything works.
2. Copy the secret key (`sk_test_...`).
3. Developers → Webhooks → Add endpoint: `https://<your-api-host>/api/webhook`, with these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`.
   Copy its signing secret (`whsec_...`).

## 3. Deploy the backend
Needs Node 20+ and a **persistent disk** for the SQLite file (on Render, add a disk and set `DB_PATH=/var/data/dragonwall.db`).
```
cd server
cp .env.example .env     # fill in every value
npm install
npm start
```
Set the same variables in your host's dashboard instead of using `.env` in production.
To test locally: `stripe listen --forward-to localhost:3000/api/webhook`, then pay with card `4242 4242 4242 4242`.

## 4. Connect the game
In `index.html`, set `const API='https://your-api-host';` and make sure `CLIENT_ORIGIN` on the server is your Pages origin (e.g. `https://yourname.github.io`).

## How payments work
- First visit: the server creates an anonymous account; a secret token is kept in the browser's localStorage.
- Buying gems: the game asks the server for a Stripe Checkout session (prices live only on the server) and opens it in a new tab.
- Gems are credited **only** by Stripe's signed webhook, once per session. Full refunds claw gems back (never below zero).
- Buying a perk spends gems on the server, which returns a signed entitlement valid for 15 minutes.
- Game hosts check each player's entitlement with `/api/verify`, so nobody can claim perks they didn't buy.

## Know before you launch
- **Accounts are tied to one browser.** Clearing site data loses the gems and perks. Add email or social login before taking real money, and tell players how to recover purchases.
- Perks carry over to every room a player joins. A room's host still controls their own game, so a host can cheat in their own room, but cannot mint gems or perks for anyone else.
- A copied entitlement works for up to 15 minutes, but only inside rooms whose host receives it.
- A refunded perk stays unlocked; only unspent gems are clawed back.
- You are responsible for tax (consider Stripe Tax), a refund policy, terms of service and a privacy policy, and local consumer rules on in-game purchases. Selling to children has extra rules in many places.

## Controls
WASD move · mouse aim · click attack · right-click/Space throw (spear, dagger, battle axe) · 1–9 swap weapon · B armory and vault
