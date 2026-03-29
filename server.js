require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai"); // Gemini

const app = express();
const PORT = process.env.PORT || 4000;

// Raw body ONLY for webhook verification
app.use("/razorpay-webhook", bodyParser.raw({ type: "*/*" }));
// Normal JSON body
app.use(express.json());
app.use(cors());

// Razorpay client
const razorpayInstance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Supabase (admin client)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Gemini client (Google AI)
const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Helper: get Supabase user from JWT sent by frontend
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

// Health check
app.get("/", (req, res) => {
  res.send("Nox backend is running");
});

// Plan → credits mapping (match PRICING.HTML plan IDs)
const PLAN_CREDITS = {
  // 1 month
  "plan_SW4tX6wgjb7Xpv": { name: "monthly", credits: 200 },
  // 12 months
  "plan_SW4troEOKKCe9T": { name: "yearly", credits: 250 },
  // 3 years
  "plan_SW4uE4Hw33PD3K": { name: "3year", credits: 300 },
};

// ========== 1) CREATE SUBSCRIPTION ==========
// Called from frontend pricing page
app.post("/create-subscription", async (req, res) => {
  try {
    const { plan_id, supabase_user_id } = req.body;

    if (!plan_id) {
      return res.status(400).json({ error: "Missing plan_id" });
    }

    if (!supabase_user_id) {
      return res.status(400).json({ error: "User not logged in" });
    }

    // Create Razorpay subscription and store supabase_user_id + plan_id in notes
    const subscription = await razorpayInstance.subscriptions.create({
      plan_id,
      total_count: 120, // many cycles; cancel manually if needed
      customer_notify: 1,
      notes: {
        supabase_user_id,
        plan_id,
      },
    });

    // Store subscription info in user_subscriptions
    const planMeta = PLAN_CREDITS[plan_id] || { name: null, credits: 0 };

    await supabase.from("user_subscriptions").insert({
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

// ========== 2) RAZORPAY WEBHOOK ==========
// Razorpay will call this after subscription activation / charge
app.post("/razorpay-webhook", async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error("Missing RAZORPAY_WEBHOOK_SECRET in environment");
      return res.status(500).send("Webhook secret not configured");
    }

    const signature = req.headers["x-razorpay-signature"];
    const body = req.body;

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

    // Handle subscription activation / recurring charge
    if (
      eventType === "subscription.activated" ||
      eventType === "subscription.charged"
    ) {
      const subscriptionObj = payload.subscription?.entity;
      if (!subscriptionObj) {
        console.error("No subscription entity in webhook payload");
        return res.json({ status: "ignored" });
      }

      const razorpaySubscriptionId = subscriptionObj.id;
      const notes = subscriptionObj.notes || {};
      const supabaseUserId = notes.supabase_user_id;
      const razorpayPlanId = subscriptionObj.plan_id || notes.plan_id;

      if (!supabaseUserId || !razorpayPlanId) {
        console.error("Missing supabase_user_id or plan_id in subscription notes");
        return res.json({ status: "ignored" });
      }

      const planMeta = PLAN_CREDITS[razorpayPlanId];
      if (!planMeta) {
        console.error("No PLAN_CREDITS mapping for plan:", razorpayPlanId);
      }

      const creditsToAdd = planMeta?.credits || 0;

      // Update user_subscriptions row
      await supabase
        .from("user_subscriptions")
        .upsert(
          {
            user_id: supabaseUserId,
            razorpay_subscription_id: razorpaySubscriptionId,
            razorpay_plan_id: razorpayPlanId,
            plan_name: planMeta?.name || null,
            credits_per_cycle: creditsToAdd,
            status: subscriptionObj.status,
            current_cycle_started_at: subscriptionObj.current_start
              ? new Date(subscriptionObj.current_start * 1000).toISOString()
              : null,
            current_cycle_ends_at: subscriptionObj.current_end
              ? new Date(subscriptionObj.current_end * 1000).toISOString()
              : null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "razorpay_subscription_id" }
        );

      // Add credits to user_credits
      if (creditsToAdd > 0) {
        const { data: existingCredits, error: creditsError } = await supabase
          .from("user_credits")
          .select("credits")
          .eq("user_id", supabaseUserId)
          .maybeSingle();

        if (creditsError) {
          console.error("Error reading user_credits:", creditsError);
        }

        const currentCredits = existingCredits?.credits || 0;

        if (existingCredits) {
          await supabase
            .from("user_credits")
            .update({
              credits: currentCredits + creditsToAdd,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", supabaseUserId);
        } else {
          await supabase
            .from("user_credits")
            .insert({
              user_id: supabaseUserId,
              credits: creditsToAdd,
            });
        }

        // Insert into credit_transactions
        await supabase.from("credit_transactions").insert({
          user_id: supabaseUserId,
          amount: creditsToAdd,
          type: "plan_credit",
          note: `Credits added for ${planMeta?.name || "subscription"} plan`,
        });
      }
    }

    res.json({ status: "ok" });
  } catch (err) {
    console.error("Error in webhook:", err);
    res.status(500).send("Webhook error");
  }
});

// ========== 3) GEMINI GENERATION ENDPOINT ==========
app.post("/api/generate-site", async (req, res) => {
  try {
    const user = await getUserFromToken(req);
    if (!user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const prompt = (req.body.prompt || "").trim();
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    // still using your existing RPC (profiles-based credits)
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      "consume_credit_and_increment",
      { p_user_id: user.id }
    );

    if (rpcError) {
      console.error("consume_credit_and_increment error:", rpcError);
      if (
        rpcError.message?.includes("No credits remaining") ||
        rpcError.details?.includes("No credits remaining")
      ) {
        return res.status(402).json({ error: "No credits remaining" });
      }
      return res.status(500).json({ error: "Could not use a credit" });
    }

    const creditsRemaining =
      Array.isArray(rpcData) && rpcData.length > 0
        ? rpcData[0].credits_remaining
        : null;

    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "You are a website generator. Output ONLY complete HTML code with <html>, <head>, <body> " +
                "and include Tailwind CSS CDN. No explanations, no markdown. " +
                "Generate a responsive website for this request: " +
                prompt,
            },
          ],
        },
      ],
    });

    console.log("GEMINI RAW RESULT =", JSON.stringify(result, null, 2));

    let html = "";
    try {
      if (result && typeof result.text === "function") {
        html = result.text();
      } else if (result && result.response && typeof result.response.text === "function") {
        html = result.response.text();
      } else if (
        result &&
        result.candidates &&
        result.candidates[0] &&
        result.candidates[0].content &&
        result.candidates[0].content.parts &&
        result.candidates[0].content.parts[0] &&
        typeof result.candidates[0].content.parts[0].text === "string"
      ) {
        html = result.candidates[0].content.parts[0].text;
      }
    } catch (e) {
      console.error("Error extracting HTML from Gemini result:", e);
    }

    if (!html || !html.trim()) {
      return res
        .status(500)
        .json({ error: "AI returned empty or unreadable HTML. Try a different prompt." });
    }

    return res.json({
      html: html.trim(),
      credits_remaining: creditsRemaining,
    });
  } catch (err) {
    console.error("generate-site error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Nox backend listening on port ${PORT}`);
});
