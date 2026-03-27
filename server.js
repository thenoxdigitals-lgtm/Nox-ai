require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai"); // NEW: Gemini

// --- Setup basic app ---
const app = express();
const PORT = process.env.PORT || 4000;

// We need raw body ONLY for webhook verification
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

// --- Setup Gemini client (Google AI Studio) ---
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

    if (!supabase_user_id) {
      return res.status(400).json({ error: "User not logged in" });
    }

    // total_count must be >= 1
    const subscription = await razorpayInstance.subscriptions.create({
      plan_id: plan_id,
      total_count: 1,
      notes: {
        supabase_user_id: supabase_user_id,
      },
    });

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
app.post("/razorpay-webhook", async (req, res) => {
  try {
    const webhookSecret = "your_webhook_secret_here"; // TODO: put in env

    const signature = req.headers["x-razorpay-signature"];
    const body = req.body; // raw body

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

    if (
      eventType === "subscription.activated" ||
      eventType === "subscription.charged"
    ) {
      const subscriptionObj = payload.subscription.entity;
      const razorpaySubscriptionId = subscriptionObj.id;
      const notes = subscriptionObj.notes || {};
      const supabaseUserId = notes.supabase_user_id;

      if (supabaseUserId) {
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

    // 1) Consume a credit via Supabase RPC
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      "consume_credit_and_increment",
      {}
    );

    if (rpcError) {
      console.error("consume_credit_and_increment error:", rpcError);
      if (rpcError.message?.includes("No credits remaining")) {
        return res.status(402).json({ error: "No credits remaining" });
      }
      return res.status(500).json({ error: "Could not use a credit" });
    }

    const creditsRemaining =
      Array.isArray(rpcData) && rpcData.length > 0
        ? rpcData[0].credits_remaining
        : null;

    // 2) Call Gemini to generate HTML
    const response = await genAI.models.generateContent({
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

    const html = response.text();

    return res.json({
      html,
      credits_remaining: creditsRemaining,
    });
  } catch (err) {
    console.error("generate-site error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Nox backend listening on port ${PORT}`);
});
