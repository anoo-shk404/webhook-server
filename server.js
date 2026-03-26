import express from "express";

import webhookRoutes from "./routes/webhook.js";
import hashingRoutes from "./routes/hashing.js";
import intermediateOrderRoutes from "./routes/intermediate_order.js";
import intermediateInvoiceRoutes from "./routes/intermediate_invoice.js";
import intermediateProductRoutes from "./routes/intermediate_products.js";
import synthesizeRoutes from "./routes/synthesize_orders.js";
import intermediateOrderUpdateRoutes from "./routes/intermediate_order_update_routes.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.use("/webhook", webhookRoutes);
app.use("/hashing", hashingRoutes);
app.use("/intermediateorder", intermediateOrderRoutes);
app.use("/intermediateinvoice", intermediateInvoiceRoutes);
app.use("/intermediateproduct", intermediateProductRoutes);
app.use("/synthesize", synthesizeRoutes);
app.use("/intermediateorderupdate", intermediateOrderUpdateRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
