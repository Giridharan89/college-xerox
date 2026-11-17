require("dotenv").config();

const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "ADMIN_KEY"
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("MISSING ENV VARIABLES:", missing.join(", "));
  console.error('Make sure the file is named exactly ".env" (not "_env") and sits next to server.js.');
  process.exit(1);
}

const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { PDFDocument } = require("pdf-lib");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png"];

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      const e = new Error("Only PDF, JPG and PNG files are allowed.");
      e.status = 400;
      return cb(e);
    }
    cb(null, true);
  },
  limits: {
    files: 5,
    fileSize: 15 * 1024 * 1024
  }
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const PORT = process.env.PORT || 3000;
const BUCKET = process.env.SUPABASE_BUCKET || "xerox-files";
const ADMIN_KEY = process.env.ADMIN_KEY;

/* Razorpay webhook: marks orders paid even if the student's browser closed.
   Must be registered BEFORE express.json() because it needs the raw body. */
app.post(
  "/api/razorpay/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) {
        return res.status(503).json({ error: "Webhook not configured." });
      }

      const signature = req.headers["x-razorpay-signature"];
      const expected = crypto
        .createHmac("sha256", secret)
        .update(req.body)
        .digest("hex");

      const a = Buffer.from(String(signature || ""));
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ error: "Invalid signature." });
      }

      const event = JSON.parse(req.body.toString("utf8"));

      if (event.event === "payment.captured" || event.event === "order.paid") {
        const payment = event.payload?.payment?.entity;
        const rpOrderId = payment?.order_id || event.payload?.order?.entity?.id;

        if (rpOrderId) {
          const { error } = await supabase
            .from("orders")
            .update({
              payment_status: "paid",
              razorpay_payment_id: payment?.id || null
            })
            .eq("razorpay_order_id", rpOrderId)
            .neq("payment_status", "paid");

          if (error) throw error;
          console.log("Webhook marked paid:", rpOrderId);
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error("WEBHOOK ERROR:", err);
      res.status(500).json({ error: "Webhook failed." });
    }
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/* Count pages on the server so students cannot under-report. */
async function countPages(file) {
  if (file.mimetype === "application/pdf") {
    const pdf = await PDFDocument.load(file.buffer, { ignoreEncryption: true });
    return pdf.getPageCount();
  }
  return 1; // each image prints as one page
}

function calculateAmountPaise(printType, pages, copies) {
  const bwPrice = Number(process.env.BW_PRICE_PER_PAGE || 2);
  const colorPrice = Number(process.env.COLOR_PRICE_PER_PAGE || 10);

  const price = printType === "color" ? colorPrice : bwPrice;

  return Math.round(price * pages * copies * 100);
}

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];

  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

/* Create order */
app.post("/api/orders", upload.array("files", 5), async (req, res) => {
  console.log("ORDER REQUEST RECEIVED");

  let order;
  try {
    const {
      studentName,
      rollNo,
      phone,
      description,
      printType,
      pages,
      copies
    } = req.body;

    console.log("Order form received:", {
      studentName,
      rollNo,
      printType,
      pages,
      copies,
      fileCount: req.files ? req.files.length : 0
    });

    const cleanCopies = Number(copies);

    if (!studentName || !rollNo) {
      return res.status(400).json({
        error: "Student name and roll number are required."
      });
    }

    if (!["bw", "color"].includes(printType)) {
      return res.status(400).json({
        error: "Invalid print type."
      });
    }

    if (!Number.isInteger(cleanCopies) || cleanCopies < 1) {
      return res.status(400).json({
        error: "Copies must be a positive whole number."
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: "Upload at least one file."
      });
    }

    let cleanPages = 0;
    try {
      for (const f of req.files) {
        cleanPages += await countPages(f);
      }
    } catch (e) {
      console.error("PAGE COUNT ERROR:", e.message);
      return res.status(400).json({
        error: "Could not read one of the PDFs. Make sure it is not corrupted."
      });
    }

    console.log("Server-counted pages:", cleanPages);

    const amountPaise = calculateAmountPaise(
      printType,
      cleanPages,
      cleanCopies
    );

    console.log("Amount in paise:", amountPaise);

    const { data: orderRow, error: dbError } = await supabase
      .from("orders")
      .insert({
        student_name: studentName.trim(),
        roll_no: rollNo.trim(),
        phone: phone?.trim() || null,
        description: description?.trim() || null,
        print_type: printType,
        pages: cleanPages,
        copies: cleanCopies,
        amount_paise: amountPaise,
        payment_status: "created",
        order_status: "pending"
      })
      .select()
      .single();

    if (dbError) {
      console.error("DATABASE ORDER ERROR:", dbError);
      throw dbError;
    }
    order = orderRow;

    console.log("Local order created:", order.id);

    for (const file of req.files) {
      const safeName = file.originalname.replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      );

      const storagePath = `${order.id}/${crypto.randomUUID()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype || "application/octet-stream",
          upsert: false
        });

      if (uploadError) {
        console.error("STORAGE UPLOAD ERROR:", uploadError);
        throw uploadError;
      }

      const { error: fileDbError } = await supabase
        .from("order_files")
        .insert({
          order_id: order.id,
          original_name: file.originalname,
          storage_path: storagePath
        });

      if (fileDbError) {
        console.error("FILE DATABASE ERROR:", fileDbError);
        throw fileDbError;
      }

      console.log("File uploaded:", file.originalname);
    }

    console.log("Creating Razorpay order...");

    const rpOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: process.env.CURRENCY || "INR",
      receipt: `xerox_${order.id}`,
      notes: {
        local_order_id: String(order.id),
        roll_no: rollNo.trim()
      }
    });

    console.log("Razorpay order created:", rpOrder.id);

    const { error: updateError } = await supabase
      .from("orders")
      .update({
        razorpay_order_id: rpOrder.id
      })
      .eq("id", order.id);

    if (updateError) {
      console.error("ORDER UPDATE ERROR:", updateError);
      throw updateError;
    }

    res.json({
      localOrderId: order.id,
      razorpayOrderId: rpOrder.id,
      amountPaise,
      pages: cleanPages,
      keyId: process.env.RAZORPAY_KEY_ID,
      currency: process.env.CURRENCY || "INR"
    });
  } catch (err) {
    if (order && order.id) {
      await supabase.from("orders").delete().eq("id", order.id); // cascades to order_files
    }
    console.error("CREATE ORDER ERROR:", {
      message: err.message,
      description: err?.error?.description,
      code: err?.error?.code,
      statusCode: err?.statusCode,
      fullError: err
    });

    const reason =
      err?.error?.description ||
      err?.message ||
      (typeof err === "string" ? err : "") ||
      "unknown error";

    res.status(500).json({
      error:
        process.env.NODE_ENV === "production"
          ? "Could not create order. Check server console."
          : `Could not create order: ${reason}`
    });
  }
});

/* Verify payment */
app.post("/api/payment/verify", async (req, res) => {
  try {
    const {
      localOrderId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    if (!localOrderId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment details." });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        error: "Payment verification failed."
      });
    }

    const { error } = await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        razorpay_payment_id,
        razorpay_signature,
        order_status: "pending"
      })
      .eq("id", localOrderId)
      .eq("razorpay_order_id", razorpay_order_id);

    if (error) {
      throw error;
    }

    res.json({
      success: true
    });
  } catch (err) {
    console.error("PAYMENT VERIFY ERROR:", err);

    res.status(500).json({
      error: "Could not verify payment."
    });
  }
});

/* Get order for student tracking */
app.get("/api/order/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select(
        "id,created_at,print_type,pages,copies,amount_paise,payment_status,order_status"
      )
      .eq("id", req.params.id)
      .single();

    if (error) {
      return res.status(404).json({
        error: "Order not found."
      });
    }

    res.json(data);

  } catch (err) {
    console.error("GET ORDER ERROR:", err);

    res.status(500).json({
      error: "Server error."
    });
  }
});

/* Admin orders */
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", {
        ascending: false
      });

    if (error) {
      throw error;
    }

    const { data: allFiles, error: filesError } = await supabase
      .from("order_files")
      .select("id,order_id,original_name,storage_path");

    if (filesError) {
      throw filesError;
    }

    for (const order of data) {
      order.files = allFiles.filter((f) => f.order_id === order.id);
    }

    res.json(data);
  } catch (err) {
    console.error("ADMIN ORDERS ERROR:", err);

    res.status(500).json({
      error: "Could not load orders."
    });
  }
});

/* Update order status */
app.post("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  const allowedStatuses = [
    "pending",
    "printing",
    "ready",
    "delivered",
    "cancelled"
  ];

  if (!allowedStatuses.includes(req.body.status)) {
    return res.status(400).json({
      error: "Invalid status."
    });
  }

  const { error } = await supabase
    .from("orders")
    .update({
      order_status: req.body.status
    })
    .eq("id", req.params.id);

  if (error) {
    return res.status(500).json({
      error: "Could not update status."
    });
  }

  res.json({
    success: true
  });
});

/* Download file */
app.get("/api/admin/files/:id/download", requireAdmin, async (req, res) => {
  try {
    const { data: file, error } = await supabase
      .from("order_files")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error) {
      return res.status(404).json({
        error: "File not found."
      });
    }

    const { data, error: signedError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(file.storage_path, 60 * 10);

    if (signedError) {
      throw signedError;
    }

    res.json({
      url: data.signedUrl,
      name: file.original_name
    });
  } catch (err) {
    console.error("DOWNLOAD ERROR:", err);

    res.status(500).json({
      error: "Could not create download link."
    });
  }
});

/* Admin page */
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* Setup self-check: open http://localhost:3000/api/health (disabled in production) */
app.get("/api/health", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not found." });
  }

  const result = {};

  try {
    const { error } = await supabase.from("orders").select("id").limit(1);
    result.supabaseOrdersTable = error
      ? "FAIL: " + error.message + " (run schema.sql in Supabase SQL Editor, or check SUPABASE_URL / service role key)"
      : "OK";
  } catch (e) {
    result.supabaseOrdersTable = "FAIL: " + e.message + " (check SUPABASE_URL)";
  }

  try {
    const { error } = await supabase.from("order_files").select("id").limit(1);
    result.supabaseOrderFilesTable = error ? "FAIL: " + error.message : "OK";
  } catch (e) {
    result.supabaseOrderFilesTable = "FAIL: " + e.message;
  }

  try {
    const { error } = await supabase.storage.from(BUCKET).list("", { limit: 1 });
    result.supabaseBucket = error
      ? `FAIL: ${error.message} (create a PRIVATE bucket named "${BUCKET}" in Supabase Storage)`
      : "OK";
  } catch (e) {
    result.supabaseBucket = "FAIL: " + e.message;
  }

  try {
    await razorpay.orders.all({ count: 1 });
    result.razorpayKeys = "OK";
  } catch (e) {
    result.razorpayKeys =
      "FAIL: " + (e?.error?.description || e.message || "unknown") +
      " (check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET, use TEST keys together)";
  }

  res.json(result);
});

/* Error handler (multer limits, bad uploads, etc.) */
app.use((err, req, res, next) => {
  console.error("EXPRESS/UPLOAD ERROR:", err);
  const msg =
    err.code === "LIMIT_FILE_SIZE" ? "File too large (max 15 MB)." :
    err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? "Max 5 files allowed." :
    err.message || "Server error.";
  res.status(err.status || (err.code && String(err.code).startsWith("LIMIT_") ? 400 : 500)).json({ error: msg });
});

/* Start server */
const server = app.listen(PORT, () => {
  console.log(`College Xerox App running at http://localhost:${PORT}`);
});

server.on("error", (err) => {
  console.error("LISTEN ERROR:", err.code === "EADDRINUSE"
    ? `Port ${PORT} is already in use. Close the other server or change PORT in .env.`
    : err);
  process.exit(1);
});

process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));