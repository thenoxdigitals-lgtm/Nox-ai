require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 4000;

// Razorpay webhook needs raw body
app.use("/razorpay-webhook", bodyParser.raw({ type: "*/*" }));
app.use(express.json());
app.use(cors());

const razorpayInstance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

async function getUserFromToken(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    console.error("getUser error:", error);
    return null;
  }
  return data.user;
}

app.get("/", (req, res) => {
  res.send("Nox backend is running");
});

const PLAN_CREDITS = {
  "plan_SW4tX6wgjb7Xpv": { name: "monthly", credits: 200 },
  "plan_SW4troEOKKCe9T": { name: "yearly", credits: 250 },
  "plan_SW4uE4Hw33PD3K": { name: "3year", credits: 300 },
};

app.post("/create-subscription", async (req, res) => {
  try {
    const { plan_id, supabase_user_id } = req.body;

    if (!plan_id) {
      return res.status(400).json({ error: "Missing plan_id" });
    }

    if (!supabase_user_id) {
      return res.status(400).json({ error: "User not logged in" });
    }

    const planMeta = PLAN_CREDITS[plan_id];
    if (!planMeta) {
      return res.status(400).json({ error: "Unknown plan_id" });
    }

    const subscription = await razorpayInstance.subscriptions.create({
      plan_id,
      total_count: 120,
      customer_notify: 1,
      notes: {
        supabase_user_id,
        plan_id,
      },
    });

    const { error: subError } = await supabase
      .from("user_subscriptions")
      .upsert(
        {
          user_id: supabase_user_id,
          razorpay_subscription_id: subscription.id,
          razorpay_plan_id: plan_id,
          plan_name: planMeta.name,
          credits_per_cycle: planMeta.credits,
          status: subscription.status,
          current_cycle_started_at: subscription.current_start
            ? new Date(subscription.current_start * 1000).toISOString()
            : null,
          current_cycle_ends_at: subscription.current_end
            ? new Date(subscription.current_end * 1000).toISOString()
            : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "razorpay_subscription_id" }
      );

    if (subError) {
      console.error("Error upserting user_subscriptions:", subError);
    }

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

function getWebhookContext(event) {
  const payload = event.payload || {};
  const eventType = event.event;

  const subscriptionEntity = payload.subscription?.entity || null;
  const paymentEntity = payload.payment?.entity || null;
  const invoiceEntity = payload.invoice?.entity || null;

  const notes =
    subscriptionEntity?.notes ||
    paymentEntity?.notes ||
    invoiceEntity?.notes ||
    {};

  const subscriptionId =
    subscriptionEntity?.id ||
    paymentEntity?.subscription_id ||
    invoiceEntity?.subscription_id ||
    null;

  const planId =
    subscriptionEntity?.plan_id ||
    notes.plan_id ||
    null;

  const userId =
    notes.supabase_user_id || null;

  let cycleStart = null;
  let cycleEnd = null;

  if (subscriptionEntity?.current_start) {
    cycleStart = new Date(subscriptionEntity.current_start * 1000).toISOString();
  }
  if (subscriptionEntity?.current_end) {
    cycleEnd = new Date(subscriptionEntity.current_end * 1000).toISOString();
  }

  if (!cycleStart && invoiceEntity?.period_start) {
    cycleStart = new Date(invoiceEntity.period_start * 1000).toISOString();
  }
  if (!cycleEnd && invoiceEntity?.period_end) {
    cycleEnd = new Date(invoiceEntity.period_end * 1000).toISOString();
  }

  const status =
    subscriptionEntity?.status ||
    invoiceEntity?.status ||
    paymentEntity?.status ||
    null;

  const uniqueRef =
    invoiceEntity?.id ||
    paymentEntity?.id ||
    `${subscriptionId}:${eventType}:${cycleStart || "no-cycle"}`;

  return {
    eventType,
    userId,
    planId,
    subscriptionId,
    cycleStart,
    cycleEnd,
    status,
    uniqueRef,
  };
}

async function addCreditsIfNotAlreadyGiven({
  userId,
  subscriptionId,
  planId,
  eventType,
  cycleStart,
  cycleEnd,
  status,
  uniqueRef,
}) {
  const planMeta = PLAN_CREDITS[planId];
  if (!planMeta) {
    console.error("No PLAN_CREDITS mapping for plan:", planId);
    return;
  }

  const creditsToAdd = planMeta.credits;

  const { error: upsertError } = await supabase
    .from("user_subscriptions")
    .upsert(
      {
        user_id: userId,
        razorpay_subscription_id: subscriptionId,
        razorpay_plan_id: planId,
        plan_name: planMeta.name,
        credits_per_cycle: creditsToAdd,
        status: status || "active",
        current_cycle_started_at: cycleStart,
        current_cycle_ends_at: cycleEnd,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "razorpay_subscription_id" }
    );

  if (upsertError) {
    console.error("Error upserting user_subscriptions:", upsertError);
  }

  const txNote = cycleStart
    ? `${eventType}:${subscriptionId}:${cycleStart}`
    : `${eventType}:${uniqueRef}`;

  const { data: existingTx, error: existingTxError } = await supabase
    .from("credit_transactions")
    .select("id")
    .eq("user_id", userId)
    .eq("type", "plan_credit")
    .eq("note", txNote)
    .maybeSingle();

  if (existingTxError) {
    console.error("Error checking existing credit transaction:", existingTxError);
  }

  if (existingTx) {
    console.log("Credits already added for this cycle/event, skipping:", txNote);
    return;
  }

  const { data: existingCredits, error: creditsError } = await supabase
    .from("user_credits")
    .select("credits")
    .eq("user_id", userId)
    .maybeSingle();

  if (creditsError) {
    console.error("Error reading user_credits:", creditsError);
  }

  const currentCredits = existingCredits?.credits || 0;

  if (existingCredits) {
    const { error: updateCreditsError } = await supabase
      .from("user_credits")
      .update({
        credits: currentCredits + creditsToAdd,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (updateCreditsError) {
      console.error("Error updating user_credits:", updateCreditsError);
      return;
    }
  } else {
    const { error: insertCreditsError } = await supabase
      .from("user_credits")
      .insert({
        user_id: userId,
        credits: creditsToAdd,
        updated_at: new Date().toISOString(),
      });

    if (insertCreditsError) {
      console.error("Error inserting user_credits:", insertCreditsError);
      return;
    }
  }

  const { error: txError } = await supabase
    .from("credit_transactions")
    .insert({
      user_id: userId,
      amount: creditsToAdd,
      type: "plan_credit",
      note: txNote,
    });

  if (txError) {
    console.error("Error inserting credit_transactions:", txError);
  }
}

app.post("/razorpay-webhook", async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error("Missing RAZORPAY_WEBHOOK_SECRET in environment");
      return res.status(500).send("Webhook secret not configured");
    }

    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.body;

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("Invalid Razorpay webhook signature");
      return res.status(400).send("Invalid signature");
    }

    const event = JSON.parse(rawBody.toString("utf8"));
    const ctx = getWebhookContext(event);

    if (
      ctx.eventType === "subscription.activated" ||
      ctx.eventType === "subscription.charged" ||
      ctx.eventType === "invoice.paid"
    ) {
      if (!ctx.userId || !ctx.planId || !ctx.subscriptionId) {
        console.error("Missing webhook context:", ctx);
        return res.json({ status: "ignored" });
      }

      await addCreditsIfNotAlreadyGiven(ctx);
    }

    return res.json({ status:
