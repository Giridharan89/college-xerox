# College Xerox App — MVP

This is a private college-use web app.

## Features

- Student form
- PDF/JPG/PNG upload
- Files stored in a private Supabase Storage bucket
- Order details stored in Supabase Postgres
- Automatic price calculation
- Razorpay online payment
- Payment signature verification on the server
- Your private admin dashboard
- Admin can download uploaded files
- Admin can change order status

## 1. Install Node.js

Install a current LTS version of Node.js.

Then open this folder in VS Code and run:

```bash
npm install
```

## 2. Create Supabase

Create a Supabase project.

In Storage, create a PRIVATE bucket called:

```text
xerox-files
```

Open SQL Editor and run everything in `schema.sql`.

From Supabase project settings, copy:
- Project URL
- Service role key

IMPORTANT: Never put the service role key in browser JavaScript.

## 3. Create Razorpay

Create a Razorpay account.

For testing, use TEST keys first.

Put the test Key ID and Secret into `.env`.

Later, replace them with LIVE keys after your account/payment setup is ready.

## 4. Create .env

Copy `.env.example` to `.env` and fill the values.

Example:

```text
PORT=3000
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxxx
SUPABASE_BUCKET=xerox-files
RAZORPAY_KEY_ID=rzp_test_xxxx
RAZORPAY_KEY_SECRET=xxxx
ADMIN_KEY=make-a-long-secret-here
BW_PRICE_PER_PAGE=2
COLOR_PRICE_PER_PAGE=10
CURRENCY=INR
```

## 5. Run

```bash
npm start
```

Open:

```text
http://localhost:3000
```

Student page:

```text
http://localhost:3000/
```

Admin page:

```text
http://localhost:3000/admin
```

## 6. Test

Use Razorpay TEST mode first.

1. Student uploads a test PDF/image.
2. Student enters pages/copies.
3. Student clicks Upload & Pay.
4. Test checkout opens.
5. Complete the test payment.
6. Order becomes paid.
7. Open `/admin`.
8. Enter your ADMIN_KEY.
9. Download the file.
10. Change status to printing/ready/delivered.

## 7. Before public launch

Do NOT publish the `.env` file.

Do NOT expose the Supabase service-role key.

Use HTTPS.

Add a proper student login/college restriction if required.

Set reasonable file-size and file-type limits.

Add a Razorpay webhook for stronger payment reliability before handling real money at scale.

Change the default pricing to your actual xerox/printing price.

## Deployment

The easiest structure is:

Student/Admin browser
        |
        v
Node.js + Express server
   |              |
   v              v
Supabase       Razorpay
DB + Storage   Payments

You can deploy the Node.js server to a service that supports Node.js. Set all `.env` values as server environment variables there.

For a college-only launch, first test locally, then deploy privately with a secret admin key and share only the student URL with your classmates.
