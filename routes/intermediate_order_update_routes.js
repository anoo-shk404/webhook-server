import express from "express";
import crypto from "crypto";

const router = express.Router();

/**
 * Computes structural changes between old and new order states
 */
function computeSubscriptionChanges(newOrders = [], oldOrders = []) {
  if (!Array.isArray(newOrders) || !Array.isArray(oldOrders)) {
    throw new Error("Orders must be arrays");
  }

  if (newOrders.some((o) => !o.priceId)) {
    throw new Error("priceId is mandatory for all new orders");
  }

  const oldMap = new Map();
  const changes = [];

  for (const item of oldOrders) {
    oldMap.set(item.priceId, Number(item.quantity) || 0);
  }

  for (const newItem of newOrders) {
    const priceId = newItem.priceId;
    const newQty = Number(newItem.quantity) || 0;
    const oldQty = oldMap.get(priceId) ?? 0;

    const delta = newQty - oldQty;

    if (delta !== 0) {
      changes.push({
        type: delta > 0 ? "INCREASE" : "DECREASE",
        priceId,
        quantity: Math.abs(delta), // always positive quantity
        oldQuantity: oldQty,
        newQuantity: newQty,
        delta, // signed delta used for sign of amounts
      });
    }

    oldMap.delete(priceId);
  }

  // Removed items
  for (const [priceId, oldQty] of oldMap.entries()) {
    if (oldQty > 0) {
      changes.push({
        type: "DECREASE",
        priceId,
        quantity: oldQty, // positive quantity
        oldQuantity: oldQty,
        newQuantity: 0,
        delta: -oldQty, // negative delta → negative amounts
      });
    }
  }

  return changes;
}

/**
 * 8-digit hash for partyRoleId and pricePlanEventId
 */
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
 * 3-digit hash (000–999) only for eventId in orderLineRef
 */
function hashShort(value) {
  if (!value || value === "unknown") return "000";
  const sha1Hex = crypto.createHash("sha1").update(value, "utf8").digest("hex");
  const largeNum = BigInt("0x" + sha1Hex);
  const shortNum = Number(largeNum % BigInt(1000));
  return shortNum.toString().padStart(3, "0");
}

function formatUnixToDate(unixTimestamp) {
  let ts =
    typeof unixTimestamp === "string"
      ? parseInt(unixTimestamp, 10)
      : unixTimestamp;
  if (isNaN(ts) || ts <= 0) {
    return new Date().toISOString().split("T")[0];
  }
  return new Date(ts * 1000).toISOString().split("T")[0];
}

/**
 * Transforms delta changes into OneBill-compatible order line format
 */
function transformDeltasToOrderFormat(payload, changes) {
  if (!payload.SubscriptionId || !payload.CustomerId) {
    throw new Error("SubscriptionId and CustomerId are required");
  }

  const {
    SubscriptionId,
    CustomerId,
    created,
    startDate,
    orders = [],
    eventId = "unknown",
  } = payload;

  const orderDetailsMap = new Map();
  for (const order of orders) {
    const priceId = order.priceId;
    if (priceId) {
      orderDetailsMap.set(priceId, {
        price: Number(order.price) || 0,
        currency: (order.currency || "USD").toUpperCase(),
        interval: order.interval || "month",
      });
    }
  }

  return changes.map((change) => {
    const details = orderDetailsMap.get(change.priceId) || {};
    const unitPriceCents = details.price || 0;
    const baseUnitPrice = unitPriceCents / 100; // positive dollars

    // Sign follows the direction of change (delta)
    const sign = Math.sign(change.delta); // +1 for increase/new, -1 for decrease/remove
    const signedUnitPrice = baseUnitPrice * sign;
    const signedTotal = baseUnitPrice * change.quantity * sign; // quantity is already positive

    const dateStr = formatUnixToDate(created || startDate);

    const eventHash = hashShort(eventId);
    const orderLineRef = `${SubscriptionId}-${change.priceId}-${eventHash}`;
    const purchaseOrderLineRef = `${SubscriptionId}-${change.priceId}`;

    return {
      orderNumber: SubscriptionId,
      subscriptionNumber: SubscriptionId,
      carvesEligible: "No",
      endDate: dateStr,
      partyRoleId: getPartyRoleId(CustomerId),
      orderLineRef,
      functionalExRate: 1,
      orderDiscountAmount: 0,
      orderQuantity: change.quantity, // always positive
      couponAmount: 0,
      sellerId: 2,
      subscriptionStartDate: dateStr,
      purchaseOrderLineRef,
      functionalCurrency: details.currency || "USD",
      unitPrice: Number(signedUnitPrice.toFixed(2)), // signed
      transactionCurrency: details.currency || "USD",
      reportingCurrency: details.currency || "USD",
      reportingExRate: 1,
      termDays: 0,
      subscriptionEndDate: dateStr,
      glCode: "1000",
      serviceInstanceId: 1,
      pricePlanEventId: getPricePlanEventId(change.priceId),
      baseListPrice: Number(signedUnitPrice.toFixed(2)), // signed
      actionType: "Changed", // always Changed
      baseUnitPrice: Number(signedUnitPrice.toFixed(2)), // signed
      totalSellPrice: Number(signedTotal.toFixed(2)), // signed
      purchaseOrderNumber: SubscriptionId,
      orderDate: dateStr,
      pricingDiscountAmount: 0,
      startDate: dateStr,
      totalListPrice: Number(signedTotal.toFixed(2)), // signed
    };
  });
}

/**
 * POST /intermediateorderupdate
 */
router.post("/", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload.SubscriptionId || !payload.CustomerId) {
      return res.status(400).json({
        success: false,
        error: "SubscriptionId and CustomerId are required",
      });
    }

    const newOrders = (payload.orders || [])
      .map((item) => ({
        priceId: item.newPriceId || item.priceId,
        quantity: item.newQuantity || item.quantity,
        price: item.newPrice || item.price || item.unitAmount,
        currency: item.currency,
        interval: item.interval,
      }))
      .filter((item) => item.priceId && item.quantity != null);

    const oldOrders = [
      ...(payload.oldOrders || []),
      ...(payload.previous_attributes?.orders || []),
    ]
      .map((item) => ({
        priceId: item.oldPriceId || item.priceId,
        quantity: item.oldQuantity || item.quantity,
      }))
      .filter((item) => item.priceId && item.quantity != null);

    const changes = computeSubscriptionChanges(newOrders, oldOrders);

    if (changes.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No changes detected",
        changes: [],
        orders: [],
      });
    }

    const formattedOrders = transformDeltasToOrderFormat(
      { ...payload, orders: newOrders },
      changes,
    );

    return res.status(200).json({
      success: true,
      message: "Order update processed successfully",
      changes,
      orders: formattedOrders,
    });
  } catch (error) {
    console.error(
      "Error in /intermediateorderupdate:",
      error.message,
      error.stack,
    );
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
