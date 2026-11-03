# Farber Fleet website 

The fleet dashboard as a normal website, for people without a Claude account. It's four files:
`index.html`, `app.js`, `style.css` and `config.js`. There's no build step and no server code.

## How access works

- Only people on the **Users** list can sign in. An admin adds an email and picks **Viewer** or **Admin**.
  The site then shows a one-time **invite code** (it works for 14 days).
- The person opens the site, presses **First time here**, enters that email, chooses a password and
  types the code. From then on they sign in with email and password.
- Every person has a **user type**: Sales, Service, Engineering or Customer (picked when inviting).
- Staff (Sales, Service, Engineering) see the fleet. **Viewers** look; **Admins** can also edit trucks,
  add trucks (which makes the tracker token) and manage users. Admins can preview the site as another
  staff type with **View as** at the top.
- **Customers** are added on the Customers side of the Users page and must be given at least one truck. They are tied to one or more trucks and only see the customer page for those trucks
  (`#customer-19227`). They never see the fleet.
- **Forgotten password:** an admin presses **Reset sign-in** for that person, which gives a new code.
  The person goes through **First time here** again.
- The site files hold no data and no secrets. The Supabase *publishable* key in `config.js` is meant
  to be public. Every screen asks the database through the `web_*` functions (see
  `supabase/web_access.sql`), and they refuse anyone who isn't signed in and on the list. Never put
  the Supabase *secret* or `service_role` key in these files.

## One-time Supabase setting (required)

Supabase's free email service only sends to your own Supabase team, so the site doesn't use email.
Turn off email confirmation so new people can create their password:

1. Open supabase.com → your project → **Authentication** → **Sign In / Providers** → **Email**.
2. Turn **Confirm email** off and press **Save**.

This is safe here because a sign-up gets nothing without a valid invite code.

## Publish on GitHub Pages (free)

1. Create a free account at github.com.
2. Create a new **public** repository, for example `farber-fleet-web`. (Pages on a free account
   needs a public repository. The files contain nothing secret; the data stays behind the login.)
3. Upload `index.html`, `app.js`, `style.css`, `config.js`, `.nojekyll` and this README:
   **Add file → Upload files**, drag them in, **Commit changes**.
4. Go to **Settings → Pages**. Under **Build and deployment**, pick **Deploy from a branch**,
   branch **main**, folder **/ (root)**, then **Save**.
5. After a minute or two the site is at `https://<your-account>.github.io/farber-fleet-web/`.

To update the site later, upload the changed files again. The page updates within a minute or two.

Do **not** put the rest of the project (firmware, `supabase/truck-tokens-*.csv`) in this
repository: the token file lets anyone pretend to be a truck.

## Pages

| Address | Page |
|---|---|
| `#trucks` | All trucks, with tiles for offline trucks, shocks and warnings |
| `#truck-19227` | One truck: right now, maintenance, details, Farber team, history charts, route, events |
| `#offline` | Trucks offline, with batteries, last location and map links |
| `#shocks` | Shocks this week, with speed, severity, city/state and map links |
| `#warnings` | Trucks with warnings: every warning per truck, status and last update |
| `#edit`, `#edit-19227` | Edit trucks (admins) |
| `#new` | Add a truck (admins) |
| `#users` | Users (admins): **Farber team** (types Sales/Service/Engineering, Viewer/Admin, tabs by type) and **Customers** (their trucks, **+ Add a truck** when they buy another, × to remove one) |
| `#customer-19227` | The customer's truck page: everything current (right now, maintenance, build/delivery) without their address/contact, the Farber team, IP address or firmware. Customers with several trucks switch with a dropdown. Staff open it with **View customer page** |
| `#mytrucks` | Opens the customer's first truck |
| `#account` | Change your password |

The menu (top left) lists them, and new pages get a line there. The theme menu has the same
20 themes as the Claude dashboard; the choice is remembered on each device.
