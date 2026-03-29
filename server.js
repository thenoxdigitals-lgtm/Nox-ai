if (
  eventType === "subscription.activated" ||
  eventType === "subscription.charged"
) {
  const subscriptionObj = payload.subscription?.entity;
  const razorpaySubscriptionId = subscriptionObj.id;
  const notes = subscriptionObj.notes || {};
  const supabaseUserId = notes.supabase_user_id;
  const razorpayPlanId = subscriptionObj.plan_id || notes.plan_id;

  const planMeta = PLAN_CREDITS[razorpayPlanId];
  const creditsToAdd = planMeta?.credits || 0;

  await supabase.from("user_subscriptions").upsert({ ... });

  if (creditsToAdd > 0) {
    const { data: existingCredits } = await supabase
      .from("user_credits")
      .select("credits")
      .eq("user_id", supabaseUserId)
      .maybeSingle();

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

    await supabase
      .from("credit_transactions")
      .insert({
        user_id: supabaseUserId,
        amount: creditsToAdd,
        type: "plan_credit",
        note: `Credits added for ${planMeta?.name || "subscription"} plan`,
      });
  }
}
