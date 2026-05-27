const mongoose = require("mongoose");
mongoose.connect(process.env.MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true });

const ContractSchema = new mongoose.Schema({
  pdfName:     String,
  fields:      mongoose.Schema.Types.Mixed, // 19 field summary
  submittals:  [
    { item: String, page: Number, reason: String }
  ],
  createdAt:   { type: Date, default: Date.now }
}, { collection: 'contracts' });

const Contract = mongoose.model("Contract", ContractSchema);
