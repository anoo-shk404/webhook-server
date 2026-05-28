// routes/intermediate_invoice.js

import express from "express";
import Stripe from "stripe";
import crypto from "crypto";

const router = express.Router();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable");
}

const stripe = Stripe(stripeSecretKey);

/* ---------------- Utilities ---------------- */

function unixToDate(unixTs) {
  return new Date(Number(unixTs) * 1000).toISOString().split("T")[0];
}

function generateBillLineId(invoiceId, enumeration) {
  return `${invoiceId}-${enumeration}`;
}

function hashTo8Digits(value) {
  const sha1Hex = crypto
    .createHash("sha1")
    .update(String(value), "utf8")
    .digest("hex");

  const largeNum = BigInt("0x" + sha1Hex);

  return (largeNum % BigInt(100_000_000)).toString().padStart(8, "0"); // always exactly 8 digits
}

function getPartyRoleId(customerId) {
  return hashTo8Digits(customerId);
}

function getPricePlanEventId(priceId) {
  return hashTo8Digits(priceId);
}

/* ---------------- Main Route ---------------- */

router.post("/", async (req, res) => {
  try {
    const { invoiceId, bill_date, invoiceItems } = req.body;

    if (!invoiceId || !bill_date || !invoiceItems) {
      return res.status(400).json({
        error: "Missing required fields: invoiceId, bill_date, invoiceItems",
      });
    }

    let subscriptionIds,
      priceIds,
      currencies,
      amounts,
      periodStarts,
      periodEnds,
      quantities;

    if (Array.isArray(invoiceItems)) {
      subscriptionIds = invoiceItems.map((i) => i.SubscriptionId);
      priceIds = invoiceItems.map((i) => i.priceId);
      currencies = invoiceItems.map((i) => i.currency);
      amounts = invoiceItems.map((i) => i.amount);
      periodStarts = invoiceItems.map((i) => i.period_start);
      periodEnds = invoiceItems.map((i) => i.period_end);
      quantities = invoiceItems.map((i) => i.quantity);
    } else {
      subscriptionIds = [].concat(invoiceItems.SubscriptionId || []);
      priceIds = [].concat(invoiceItems.priceId || []);
      currencies = [].concat(invoiceItems.currency || []);
      amounts = [].concat(invoiceItems.amount || []);
      periodStarts = [].concat(invoiceItems.period_start || []);
      periodEnds = [].concat(invoiceItems.period_end || []);
      quantities = [].concat(invoiceItems.quantity || []);
    }

    const itemCount = subscriptionIds.length;

    if (
      [
        priceIds,
        currencies,
        amounts,
        periodStarts,
        periodEnds,
        quantities,
      ].some((arr) => arr.length !== itemCount)
    ) {
      return res.status(400).json({
        error: "Mismatch in invoiceItems array lengths",
      });
    }

    /* -------- Fetch Price Details -------- */

    const uniquePriceIds = [...new Set(priceIds.filter(Boolean))];

    const priceResults = await Promise.all(
      uniquePriceIds.map(async (priceId) => {
        try {
          const price = await stripe.prices.retrieve(priceId);
          return {
            priceId,
            isRecurring: price.type === "recurring",
            unitAmount: price.unit_amount?.toString() || "0",
            interval: price.recurring?.interval || "one_time",
            currency: price.currency?.toLowerCase() || "usd",
          };
        } catch (err) {
          console.error(`Price fetch failed for ${priceId}:`, err.message);
          return {
            priceId,
            isRecurring: false,
            unitAmount: "0",
            interval: "one_time",
            currency: "usd",
          };
        }
      }),
    );

    const priceMap = Object.fromEntries(
      priceResults.map((p) => [p.priceId, p]),
    );

    /* -------- Fetch Subscription Details -------- */

    const uniqueSubIds = [...new Set(subscriptionIds.filter(Boolean))];

    const subResults = await Promise.all(
      uniqueSubIds.map(async (subId) => {
        try {
          const sub = await stripe.subscriptions.retrieve(subId);
          return {
            subId,
            customerId: sub.customer || null,
            created: sub.created?.toString() || null,
            startDate: sub.start_date?.toString() || null,
          };
        } catch (err) {
          console.error(`Sub fetch failed for ${subId}:`, err.message);
          return { subId, customerId: null, created: null, startDate: null };
        }
      }),
    );

    const subMap = Object.fromEntries(subResults.map((s) => [s.subId, s]));

    /* -------- Build Output -------- */

    const billDate = unixToDate(bill_date);

    const invoices = subscriptionIds.map((subId, index) => {
      const priceId = priceIds[index];

      const priceInfo = priceMap[priceId] || {
        isRecurring: false,
        unitAmount: amounts[index]?.toString() || "0",
        interval: "one_time",
        currency: "usd",
      };

      const subInfo = subId ? subMap[subId] || {} : {};

      const currencyCode = currencies[index]?.toUpperCase() || "USD";
      const billAmount = parseFloat((Number(amounts[index]) / 100).toFixed(2));

      // Generate + Hash BillLineId
      const rawBillLineId = generateBillLineId(invoiceId, index + 1);
      const billLineId = hashTo8Digits(rawBillLineId);

      const rawStartDate =
        subInfo.startDate ||
        periodStarts[index]?.toString() ||
        bill_date.toString();

      return {
        billLineId,
        billNumber: invoiceId,
        billDate,
        billQuantity: Number(quantities[index]),
        billAmount,
        startDate: unixToDate(periodStarts[index]),
        endDate: unixToDate(periodEnds[index]),
        transactionCurrency: currencyCode,
        functionalCurrency: currencyCode,
        reportingCurrency: currencyCode,
        functionalExRate: 1.0,
        reportingExRate: 1.0,
        glCode: "1000",
        sellerId: 2,

        // synthesize_orders fields
        subscriptionId: subId || null,
        priceId: priceId || null,
        customerId: subInfo.customerId || null,
        partyRoleId: subInfo.customerId
          ? getPartyRoleId(subInfo.customerId)
          : null,
        pricePlanEventId: priceId ? getPricePlanEventId(priceId) : null,

        isRecurring: priceInfo.isRecurring,
        unitAmount: priceInfo.unitAmount,
        interval: priceInfo.interval,
        currency: priceInfo.currency,
        quantity: quantities[index]?.toString() || "1",

        startDateUnix: rawStartDate,
        startDateConverted: unixToDate(rawStartDate),

        created: subInfo.created || bill_date.toString(),
        createdConverted: unixToDate(subInfo.created || bill_date.toString()),

        orderLineRef: `${subId || "one-time"}-${priceId || "unknown"}`,
        isChangedOrder: false,
      };
    });

    res.status(200).json({ invoices });
  } catch (err) {
    console.error("Intermediate invoice error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
