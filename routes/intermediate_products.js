import express from "express";

const router = express.Router();

function mapChargeType(stripeType, recurring) {
  if (!recurring || !stripeType) return "one_time";
  const map = {
    recurring: "recurring",
    one_time: "one_time",
  };
  return map[stripeType] || "one_time";
}

function mapChargeFrequency(stripeInterval, recurring) {
  if (!recurring || !stripeInterval) return "purchase";
  const map = {
    month: "month",
    year: "YEARLY",
    week: "WEEKLY",
    day: "DAILY",
  };
  return map[stripeInterval] || "purchase";
}

router.post("/", (req, res) => {
  const { type, frequency } = req.body;

  const chargeType = mapChargeType(type, type);
  const chargeFrequency = mapChargeFrequency(frequency, frequency);

  res.status(200).json({
    chargeType,
    chargeFrequency,
  });
});

export default router;
