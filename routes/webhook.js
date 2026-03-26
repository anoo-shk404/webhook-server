import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  res.send("Webhook server is running");
});

router.post("/", (req, res) => {
  console.log("Webhook received:", JSON.stringify(req.body, null, 2));
  res.status(200).json({ message: "Received" });
});

export default router;
