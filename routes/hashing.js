import express from "express";
import crypto from "crypto";

const router = express.Router();

function hashId(id) {
  const sha1Hex = crypto.createHash("sha1").update(id, "utf8").digest("hex");
  const largeNum = BigInt("0x" + sha1Hex);
  return Number(largeNum % BigInt(100_000_000));
}

router.post("/", (req, res) => {
  const { customerId, name, productId } = req.body;

  if (!customerId) {
    return res.status(400).json({ error: "customerId is required" });
  }

  if (customerId.startsWith("price")) {
    return res.status(200).json({
      hashedPrice: hashId(customerId),
      hashedProduct: productId ? hashId(productId) : null,
      sellerId: 2,
    });
  }

  res.status(200).json({
    originalId: customerId,
    hashedId: hashId(customerId),
    name: name || null,
    sellerId: 2,
  });
});

export default router;
