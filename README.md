# Farber Fleet website 

The fleet dashboard as a normal website, for people without a Claude account. It's four files:
`index.html`, `app.js`, `style.css` and `config.js`. There's no build step and no server code.

## How access works

- Only people on the **Users** list can sign in. An admin adds an email and picks **Viewer** or **Admin**.
  The site then shows a one-time **invite code** (it works for 14 days).
- The person opens the site, presses **First time here**, enters that email, chooses a password and
  types the code. From then on they sign in with email and password.
- Every person has a **user type**: Sales, Service, Engineering or Customer (picked when inviting).
- Staff (Sales, Service, Engineering) see the fleet. On a truck page, **Sales** sees only Location (with the Farber Fleet Connection),
  the truck details (build/delivery, address, contact, Farber team) and a **View customer page** button. Sales doesn't get the Trucks offline, Shocks
  and Warnings pages, and sees no warnings on the fleet list or truck pages.
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
| `#truck-19227` | One truck: truck details (address, contact, Farber team), maintenance buttons (Service), service requests, events, right now (oil changes are in the Truck and Generator cards), history charts |
| `#offline` | Trucks offline, with batteries, last location and map links |
| `#shocks` | Shocks this week, with speed, severity, city/state and map links |
| `#warnings` | Trucks with warnings: every warning per truck with its open ticket, or **Open ticket** (Service and admins) to start one filled in from the warning |
| `#edit`, `#edit-19227` | Edit trucks (admins) |
| `#new` | Add a truck (admins) |
| `#users` | Users (admins): **Farber team** (types Sales/Service/Engineering, Viewer/Admin, tabs by type) and **Customers** (their trucks, **+ Add a truck** when they buy another, × to remove one) |
| `#customer-19227` | The customer's truck page: everything current (right now, maintenance, build/delivery) without their address/contact, the Farber team, IP address, firmware or connection details (Location shows Online or Offline instead). Customers with several trucks switch with a dropdown. Admins and Sales open it with **View customer page** |
| `#work-19227`, `#schedule-19227`, `#done-19227` | Service pages (Service users and admins): **Maintenance history** (every oil change, inspection, repair, warranty job, breakdown and upgrade, with filters and search), **Schedule maintenance** and **Add maintenance completed** (both create tickets); the buttons are in the truck page's Maintenance section |
| `#requests` | Service tickets (Service users and admins): open tickets first plus the last 90 days of closed ones, filters, search, **New ticket** |
| `#ticket-11001` | One ticket. Service users and admins edit every field and add team notes; status, schedule and assignment changes are logged as notes. The truck's customer sees a read-only version without notes |
| `#newticket` | New ticket for any truck (Service users and admins) |
| `#request-19227` | A customer's Request service form: type, urgency, a short summary, details, where the truck is (its GPS position or typed) and who to contact (can be someone else). It creates a ticket |
| `#mytrucks` | Opens the customer's first truck |
| `#account` | Change your password |

The menu (top left) lists them, and new pages get a line there. The theme menu has the same
20 themes as the Claude dashboard; the choice is remembered on each device.

## Service tickets

Every job has a ticket number: customer requests, scheduled work and finished maintenance (the old
maintenance records and requests were numbered #10001–#11077, oldest first). A finished ticket is part of the
truck's Maintenance history; a finished oil change ticket ("Counts as an oil change") resets the due date.
Only Service users and admins can edit tickets or read and write team notes. Customers can create tickets for
their own trucks and see them read-only.
On a ticket, Service users and admins have quick buttons: **Start work** (New/Scheduled → In progress), **Mark done**
(asks for the date and what was done), **Cancel ticket** and **Reopen ticket** (both ask for a reason). Reopen
works on any closed ticket, however old. Every change is written to the team notes.
