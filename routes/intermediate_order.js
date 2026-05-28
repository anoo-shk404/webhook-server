import express from "express";
import crypto from "crypto";

const router = express.Router();

/* ---------------- Utilities ---------------- */

function getPartyRoleId(customerId) {
  if (!customerId) return 0;
  const sha1Hex = crypto
    .createHash("sha1")
    .update(customerId, "utf8")
    .digest("hex");
  const largeNum = BigInt("0x" + sha1Hex);
  return Number(largeNum % BigInt(100_000_000));
}

function getPricePlanEventId(priceId) {
  if (!priceId) return 0;
  const sha1Hex = crypto
    .createHash("sha1")
    .update(priceId, "utf8")
    .digest("hex");
  const largeNum = BigInt("0x" + sha1Hex);
  return Number(largeNum % BigInt(100_000_000));
}

/**
 * 3-digit hash (000–999) — same as used in the update/change endpoint
 */
function hashShort(value) {
  if (!value || value === "unknown") return "000";
  const sha1Hex = crypto.createHash("sha1").update(value, "utf8").digest("hex");
  const largeNum = BigInt("0x" + sha1Hex);
  const shortNum = Number(largeNum % BigInt(1000));
  return shortNum.toString().padStart(3, "0");
}

function unixToDate(unixTs) {
  return new Date(Number(unixTs) * 1000).toISOString().split("T")[0];
}

function addInterval(dateStr, interval, intervalCount = 1) {
  const date = new Date(dateStr);
  if (interval === "month") date.setMonth(date.getMonth() + intervalCount);
  else if (interval === "year")
    date.setFullYear(date.getFullYear() + intervalCount);
  else if (interval === "week")
    date.setDate(date.getDate() + 7 * intervalCount);
  else if (interval === "day") date.setDate(date.getDate() + intervalCount);
  return date.toISOString().split("T")[0];
}

function daysBetween(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
}

/* ---------------- Main Route ---------------- */

router.post("/", (req, res) => {
  try {
    const {
      CustomerId,
      SubscriptionId,
      created,
      startDate,
      orders,
      type, // mandatory: "customer.subscription.created" or ".deleted"
      eventId = "unknown", // optional → defaults to "unknown" → "000"
    } = req.body;

    if (
      !type ||
      ![
        "customer.subscription.created",
        "customer.subscription.deleted",
      ].includes(type)
    ) {
      return res.status(400).json({
        error:
          "type is required and must be 'customer.subscription.created' or 'customer.subscription.deleted'",
      });
    }

    if (
      !CustomerId ||
      !SubscriptionId ||
      created == null ||
      startDate == null ||
      !Array.isArray(orders) ||
      orders.length === 0
    ) {
      return res.status(400).json({
        error:
          "Missing or invalid required fields: CustomerId, SubscriptionId, created, startDate, orders (non-empty array)",
      });
    }

    const partyRoleId = getPartyRoleId(CustomerId);
    const orderDate = unixToDate(created);
    const subscriptionStartDate = unixToDate(startDate);

    const isDeletion = type === "customer.subscription.deleted";
    const sign = isDeletion ? -1 : 1;

    const eventHash = hashShort(eventId); // 000–999, consistent with update endpoint

    const mappedOrders = orders.map((item, index) => {
      const { priceId, price, interval, currency, quantity = 1 } = item;

      if (!priceId || price == null || !interval || !currency) {
        throw new Error(
          `Order item at index ${index} missing required fields: priceId, price, interval, currency`,
        );
      }

      const subscriptionEndDate = addInterval(
        subscriptionStartDate,
        interval,
        1,
      );
      const termDays = daysBetween(subscriptionStartDate, subscriptionEndDate);

      const unitPrice = Number(price) / 100;
      const qty = Number(quantity);
      const signedUnitPrice = unitPrice * sign;
      const totalPrice = parseFloat((signedUnitPrice * qty).toFixed(2));

      const pricePlanEventId = getPricePlanEventId(priceId); // still used in creation

      const purchaseOrderLineRef = `${SubscriptionId}-${priceId}`;

      let orderLineRef;
      if (isDeletion) {
        // Deletion: uses eventId short hash (same function as update endpoint)
        orderLineRef = `${SubscriptionId}-${priceId}-${eventHash}`;
      } else {
        // Creation: keeps original shorter format with price-based event id
        orderLineRef = `${SubscriptionId}-${priceId}`;
      }

      return {
        orderLineRef,
        purchaseOrderLineRef,
        actionType: isDeletion ? "Cancel" : "New",
        subscriptionNumber: SubscriptionId,
        orderNumber: SubscriptionId,
        purchaseOrderNumber: SubscriptionId,
        serviceInstanceId: 1,
        pricePlanEventId, // still included as separate field
        partyRoleId,
        sellerId: 2,
        orderDate,
        subscriptionStartDate,
        startDate: subscriptionStartDate,
        subscriptionEndDate,
        endDate: subscriptionEndDate,
        termDays,
        orderQuantity: qty, // always positive
        unitPrice: signedUnitPrice,
        baseUnitPrice: signedUnitPrice,
        totalListPrice: totalPrice,
        baseListPrice: totalPrice,
        totalSellPrice: totalPrice,
        couponAmount: 0.0,
        pricingDiscountAmount: 0.0,
        orderDiscountAmount: 0.0,
        transactionCurrency: currency.toUpperCase(),
        functionalCurrency: currency.toUpperCase(),
        reportingCurrency: currency.toUpperCase(),
        functionalExRate: 1.0,
        reportingExRate: 1.0,
        carvesEligible: "No",
        glCode: isDeletion ? "2999" : "1000",
        isChangedOrder: false,
      };
    });

    res.status(200).json({ orders: mappedOrders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
