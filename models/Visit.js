import mongoose from 'mongoose';

// Sub-schema for Vital Signs
const vitalSignsSchema = new mongoose.Schema({
  temperature: Number,
  bloodPressure: String, // e.g., "120/80"
  heartRate: Number,
  respiratoryRate: Number,
  oxygenSaturation: Number,
}, { _id: false });

// Sub-schema for Diagnosis
const diagnosisSchema = new mongoose.Schema({
  condition: { type: String, required: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  diagnosedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  notes: String,
  icd10Code: String,
  isFinal: { type: Boolean, default: false }
}, { _id: false });

// Sub-schema for Lab Orders
const labOrderSchema = new mongoose.Schema({
  testName: { type: String, required: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  orderedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['Pending', 'Completed', 'Cancelled'], default: 'Pending' },
  results: String,
  notes: String,
  price: { type: Number, default: 0 },
  paymentStatus: { 
    type: String, 
    enum: ['pending', 'paid', 'insurance_claimed', 'waived'], 
    default: 'pending' 
  }
}, { timestamps: true });

// Sub-schema for Prescriptions
const prescriptionSchema = new mongoose.Schema({
  medication: { type: String, required: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  dosage: { type: String, required: true },
  frequency: { type: String, required: true },
  duration: String,
  notes: String,
  prescribedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  price: { type: Number, default: 0 },
  paymentStatus: { 
    type: String, 
    enum: ['pending', 'paid', 'insurance_claimed', 'waived'], 
    default: 'pending' 
  },
  createdAt: { type: Date, default: Date.now },
  isActive: {
    type: Boolean,
    default: true
  }
});

// Sub-schema for Service Charges (tracks all billable services)
const serviceChargeSchema = new mongoose.Schema({
  serviceType: { 
    type: String, 
    enum: ['consultation', 'lab_test', 'radiology', 'prescription', 'procedure', 'other'],
    required: true 
  },
  serviceName: { type: String, required: true },
  serviceId: { type: mongoose.Schema.Types.ObjectId }, // Reference to actual service/order
  price: { type: Number, required: true, default: 0 },
  quantity: { type: Number, default: 1 },
  totalPrice: { type: Number, required: true },
  isCoveredByInsurance: { type: Boolean, default: false },
  insuranceCoverage: { type: Number, default: 0 }, // Amount covered by insurance
  patientResponsibility: { type: Number, required: true }, // Amount patient must pay
  paymentStatus: { 
    type: String, 
    enum: ['pending', 'paid', 'insurance_claimed', 'partially_paid', 'waived'], 
    default: 'pending' 
  },
  paidAmount: { type: Number, default: 0 },
  addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  notes: String
}, { timestamps: true });

// Sub-schema for Payment Records
const paymentRecordSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  paymentMethod: { 
    type: String, 
    enum: ['cash', 'card', 'mobile_money', 'insurance', 'bank_transfer'],
    required: true 
  },
  paymentType: {
    type: String,
    enum: ['consultation_fee', 'service_payment', 'deposit', 'full_payment'],
    required: true
  },
  receiptNumber: String,
  transactionId: String,
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  notes: String,
  paymentDate: { type: Date, default: Date.now }
}, { timestamps: true });

const visitSchema = new mongoose.Schema({
  visitId: { type: String, unique: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  visitDate: { type: Date, default: Date.now },
  status: { 
    type: String, 
    enum: ['Pending Payment', 'In Queue', 'In-Progress', 'completed'], 
    default: 'Pending Payment' 
  },
  type: { 
    type: String, 
    enum: ['consultation', 'emergency', 'follow-up', 'routine'], 
    required: true 
  },
  reason: { type: String, required: true },
  symptoms: [String],
  startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  room: String,
  notes: String,
  duration: Number,
  vitalSigns: vitalSignsSchema,
  diagnosis: [diagnosisSchema],
  labOrders: [labOrderSchema],
  prescriptions: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Prescription'
  },
  
  // Financial tracking fields
  serviceCharges: [serviceChargeSchema],
  paymentRecords: [paymentRecordSchema],
  
  // Summary financial fields
  totalCharges: { type: Number, default: 0 },
  insuranceCoverage: { type: Number, default: 0 },
  patientResponsibility: { type: Number, default: 0 },
  totalPaid: { type: Number, default: 0 },
  outstandingBalance: { type: Number, default: 0 },
  
  // Payment status tracking
  consultationFeePaid: { type: Boolean, default: false },
  consultationFeeAmount: { type: Number, default: 0 },
  allServicesPaid: { type: Boolean, default: false },

  isActive: {
    type: Boolean,
    default: true
  }

}, {
  timestamps: true
});

// Pre-save middleware to generate visit ID
visitSchema.pre('save', async function(next) {
  if (this.isNew && !this.visitId) {
    const year = new Date().getFullYear().toString().slice(-2);
    const count = await this.constructor.countDocuments();
    this.visitId = `V${year}${(count + 1).toString().padStart(5, '0')}`;
  }
  next();
});

// Method to calculate financial totals
visitSchema.methods.calculateFinancials = function() {
  // Calculate total charges
  this.totalCharges = this.serviceCharges.reduce((sum, charge) => sum + charge.totalPrice, 0);
  
  // Calculate insurance coverage
  this.insuranceCoverage = this.serviceCharges.reduce((sum, charge) => sum + charge.insuranceCoverage, 0);
  
  // Calculate patient responsibility
  this.patientResponsibility = this.serviceCharges.reduce((sum, charge) => sum + charge.patientResponsibility, 0);
  
  // Calculate total paid
  this.totalPaid = this.paymentRecords.reduce((sum, payment) => sum + payment.amount, 0);
  
  // Calculate outstanding balance
  this.outstandingBalance = this.patientResponsibility - this.totalPaid;
  
  // Check if all services are paid
  this.allServicesPaid = this.outstandingBalance <= 0;
  
  return this;
};

// Method to add a service charge
visitSchema.methods.addServiceCharge = function(serviceData, user) {
  const {
    serviceType,
    serviceName,
    serviceId,
    price,
    quantity = 1,
    hasInsurance = false,
    insuranceCoveragePercentage = 0,
    notes
  } = serviceData;

  const totalPrice = price * quantity;
  const insuranceCoverage = hasInsurance ? (totalPrice * insuranceCoveragePercentage / 100) : 0;
  const patientResponsibility = totalPrice - insuranceCoverage;

  this.serviceCharges.push({
    serviceType,
    serviceName,
    serviceId,
    price,
    quantity,
    totalPrice,
    isCoveredByInsurance: hasInsurance,
    insuranceCoverage,
    patientResponsibility,
    paymentStatus: hasInsurance ? 'insurance_claimed' : 'pending',
    addedBy: user,
    notes
  });

  this.calculateFinancials();
  return this;
};

// Method to record a payment
visitSchema.methods.recordPayment = function(paymentData, user) {
  const {
    amount,
    paymentMethod,
    paymentType,
    receiptNumber,
    transactionId,
    notes
  } = paymentData;

  this.paymentRecords.push({
    amount,
    paymentMethod,
    paymentType,
    receiptNumber,
    transactionId,
    receivedBy: user,
    notes
  });

  // Mark consultation fee as paid if this is consultation payment
  if (paymentType === 'consultation_fee') {
    this.consultationFeePaid = true;
    this.consultationFeeAmount = amount;
  }

  this.calculateFinancials();
  return this;
};

// Method to get payment summary
visitSchema.methods.getPaymentSummary = function() {
  return {
    visitId: this.visitId,
    totalCharges: this.totalCharges,
    insuranceCoverage: this.insuranceCoverage,
    patientResponsibility: this.patientResponsibility,
    totalPaid: this.totalPaid,
    outstandingBalance: this.outstandingBalance,
    consultationFeePaid: this.consultationFeePaid,
    allServicesPaid: this.allServicesPaid,
    serviceCharges: this.serviceCharges,
    paymentRecords: this.paymentRecords
  };
};

// Instance method to end visit
visitSchema.methods.endVisit = function(endedById, endNotes = '') {
  if (this.status !== 'In-Progress') throw new Error('Visit is not in progress.');
  this.status = 'completed';
  this.endedBy = endedById;
  if (endNotes) {
    this.notes = `${this.notes || ''}\nEnd Note: ${endNotes}`;
  }
  return this.save();
};

// Static method to get visits with outstanding payments
visitSchema.statics.getVisitsWithOutstandingPayments = function() {
  return this.find({
    outstandingBalance: { $gt: 0 },
    isActive: true
  }).populate('patient', 'firstName lastName patientId')
    .populate('doctor', 'firstName lastName');
};

export default mongoose.model('Visit', visitSchema);