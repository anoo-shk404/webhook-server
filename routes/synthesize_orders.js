// routes/synthesize_orders.js

import express from "express";
import axios from "axios";

const router = express.Router();

const ONEBILL_TRIGGER_URL =
  "https://sandbox.onebillsoftware.com/proactive/rest/api/admin/internal/triggerworkflow/synchronous/an/STRIPE_SUBSCRIPTION?requestFrom=OwnSystem&responseWaitingTime=10";

/* ---------------- Robust Date Utilities ---------------- */

function normalizeToUnixSeconds(value) {
  if (!value) return null;

  // Already ISO date (YYYY-MM-DD)
  if (typeof value === "string" && value.includes("-")) {
    const ms = new Date(value).getTime();
    if (isNaN(ms)) return null;
    return Math.floor(ms / 1000);
  }

  const num = Number(value);
  if (isNaN(num)) return null;

  // If milliseconds (13 digits), convert to seconds
  if (num > 9999999999) {
    return Math.floor(num / 1000);
  }

  return num; // already seconds
}

function unixToIsoDate(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString().split("T")[0];
}

function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function subtractDays(isoDate, days) {
  return addDays(isoDate, -days);
}

/* ---------------- Route ---------------- */

router.post("/", async (req, res) => {
  try {
    const { orders = [] } = req.body;

    if (!Array.isArray(orders) || orders.length === 0) {
      return res
        .status(400)
        .json({ error: "orders must be a non-empty array" });
    }

    if (orders.some((item) => typeof item.isRecurring !== "boolean")) {
      return res.status(400).json({
        error: "Every order item must have 'isRecurring' field of type boolean",
      });
    }

    const oneTimeOrders = orders.filter((item) => item.isRecurring === false);

    if (oneTimeOrders.length === 0) {
      return res.status(400).json({
        error: "No one-time (non-recurring) items found in the orders array",
      });
    }

    const firstItem = oneTimeOrders[0];

    const CustomerId = firstItem.customerId || firstItem.CustomerId;

    const SubscriptionId = firstItem.subscriptionId || firstItem.SubscriptionId;

    const createdRaw = firstItem.created;
    const startDateRaw = firstItem.startDate || firstItem.start_date;

    if (!CustomerId || !createdRaw || !startDateRaw || !SubscriptionId) {
      return res.status(400).json({
        error:
          "Missing required fields: customerId, created, startDate, subscriptionId",
      });
    }

    const createdUnix = normalizeToUnixSeconds(createdRaw);
    const startDateUnix = normalizeToUnixSeconds(startDateRaw);

    if (!createdUnix || !startDateUnix) {
      return res.status(400).json({
        error: "Invalid date format for created or startDate",
      });
    }

    const createdIso = unixToIsoDate(createdUnix);
    const startDateIso = unixToIsoDate(startDateUnix);

    /* ---------------- Build Fake Items ---------------- */

    const fakeItemsData = oneTimeOrders.map((item) => {
      const unitAmount = item.unitAmount || item.price || "0";

      return {
        id: null,
        object: "subscription_item",
        billing_thresholds: null,
        created: createdIso,
        current_period_end: addDays(startDateIso, 30),
        current_period_start: startDateIso,
        discounts: [],
        metadata: {},
        plan: {
          id: item.priceId || null,
          object: "plan",
          active: true,
          amount: unitAmount,
          amount_decimal: unitAmount,
          billing_scheme: "per_unit",
          created: subtractDays(createdIso, 1),
          currency: item.currency?.toLowerCase() || "usd",
          interval: "one_time",
          interval_count: "1",
          livemode: false,
          metadata: {},
          nickname: null,
          product: null,
          tiers_mode: null,
          transform_usage: null,
          trial_period_days: null,
          usage_type: "licensed",
        },
        price: {
          id: item.priceId || null,
          object: "price",
          active: true,
          billing_scheme: "per_unit",
          created: subtractDays(createdIso, 1),
          currency: item.currency?.toLowerCase() || "usd",
          custom_unit_amount: null,
          livemode: false,
          lookup_key: null,
          metadata: {},
          nickname: null,
          product: null,
          recurring: null,
          tax_behavior: "unspecified",
          tiers_mode: null,
          transform_quantity: null,
          type: "one_time",
          unit_amount: unitAmount,
          unit_amount_decimal: unitAmount,
        },
        quantity: Number(item.quantity) || 1,
        subscription: SubscriptionId,
        tax_rates: [],
        interval: "one_time",
      };
    });

    /* ---------------- Final Payload ---------------- */

    const payload = {
      data: {
        object: {
          id: SubscriptionId,
          object: "subscription",
          customer: CustomerId,
          created: createdUnix,
          start_date: startDateUnix,
          currency: firstItem.currency?.toLowerCase() || "usd",
          status: "active",
          livemode: false,
          collection_method: "charge_automatically",
          metadata: {},
          interval: "one_time",
          items: {
            object: "list",
            data: fakeItemsData,
            has_more: false,
            total_count: fakeItemsData.length,
          },
          plan: {
            interval: "one_time",
            interval_count: 1,
            amount: fakeItemsData[0]?.plan?.amount || "0",
            currency: firstItem.currency?.toLowerCase() || "usd",
            active: true,
            object: "plan",
            id: null,
          },
        },
      },
      previous_attributes: null,
    };

    await axios.post(ONEBILL_TRIGGER_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("Synthesize error:", err.message, err.stack);
    res.status(500).json({
      error: "Failed to process",
      details: err.message,
    });
  }
});

export default router;
