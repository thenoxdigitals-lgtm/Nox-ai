require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");

// --- Setup basic app ---
const app = express();
const PORT = process.env.PORT || 4000;

// We need raw body ONLY for webhook verification later
app.use("/razorpay-webhook", bodyParser.raw({ type: "*/*" }));
// For normal JSON body
app.use(express.json());
app.use(cors());

// --- Setup Razorpay client ---
const razorpayInstance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// --- Setup Supabase (admin client) ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Simple health check
app.get("/", (req, res) => {
  res.send("Nox backend is running");
});

// ========== 1) CREATE SUBSCRIPTION ENDPOINT ==========
app.post("/create-subscription", async (req, res) => {
  try {
    const { plan_id, supabase_user_id } = req.body;

    if (!plan_id) {
      return res.status(400).json({ error: "Missing plan_id" });
    }

    // Optional: ensure user exists in Supabase before creating subscription
    if (!supabase_user_id) {
      return res.status(400).json({ error: "User not logged in" });
    }

    // Create Razorpay subscription
    // total_count: 0 = until cancelled, or set a number for fixed cycles
    // Create Razorpay subscription
// total_count: must be >= 1
const subscription = await razorpayInstance.subscriptions.create({
  plan_id: plan_id,
  total_count: 1,   // was 0
  notes: {
    supabase_user_id: supabase_user_id,
  },
});

    // You can store subscription.id immediately mapped to user
    await supabase.from("subscriptions").insert({
      supabase_user_id,
      razorpay_subscription_id: subscription.id,
      plan_id,
      status: subscription.status,
    });

    return res.json({
      subscription_id: subscription.id,
      status: subscription.status,
      currency: subscription.currency || "INR",
      description: "Nox AI subscription",
    });
  } catch (err) {
    console.error("Error creating subscription:", err);
    return res.status(500).json({ error: "Failed to create subscription" });
  }
});

// ========== 2) RAZORPAY WEBHOOK ENDPOINT ==========
const crypto = require("crypto");

app.post("/razorpay-webhook", async (req, res) => {
  try {
    const webhookSecret = "your_webhook_secret_here"; // set same in Razorpay dashboard

    const signature = req.headers["x-razorpay-signature"];
    const body = req.body; // raw body because of bodyParser.raw

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(body)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("Invalid Razorpay webhook signature");
      return res.status(400).send("Invalid signature");
    }

    const event = JSON.parse(body.toString());

    const eventType = event.event;
    const payload = event.payload || {};

    if (eventType === "subscription.activated" || eventType === "subscription.charged") {
      const subscriptionObj = payload.subscription.entity;
      const razorpaySubscriptionId = subscriptionObj.id;
      const notes = subscriptionObj.notes || {};
      const supabaseUserId = notes.supabase_user_id;

      if (supabaseUserId) {
        // Decide credits by plan_id or amount, for now hardcode example:
        let creditsToAdd = 0;

        if (subscriptionObj.plan_id === "plan_SVRRQoK3FvsFY2") {
          creditsToAdd = 200; // monthly
        } else if (subscriptionObj.plan_id === "plan_SVRSPwR7DTzHEH") {
          creditsToAdd = 250; // yearly
        } else if (subscriptionObj.plan_id === "plan_SVRTWBZ5tiA87t") {
          creditsToAdd = 300; // 3 years
        }

        // 1) Update subscriptions table
        await supabase
          .from("subscriptions")
          .update({
            status: subscriptionObj.status,
          })
          .eq("razorpay_subscription_id", razorpaySubscriptionId);

        // 2) Add credits to user
        if (creditsToAdd > 0) {
          const { data: profile } = await supabase
            .from("profiles")
            .select("credits_remaining")
            .eq("id", supabaseUserId)
            .single();

          const currentCredits = profile?.credits_remaining || 0;

          await supabase
            .from("profiles")
            .update({
              credits_remaining: currentCredits + creditsToAdd,
              current_plan: subscriptionObj.plan_id,
            })
            .eq("id", supabaseUserId);
        }
      }
    }

    // You can also handle subscription.cancelled etc.
    res.json({ status: "ok" });
  } catch (err) {
    console.error("Error in webhook:", err);
    res.status(500).send("Webhook error");
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Nox backend listening on port ${PORT}`);
});