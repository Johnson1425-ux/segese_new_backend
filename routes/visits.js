import express from 'express';
import { body, validationResult } from 'express-validator';
import Visit from '../models/Visit.js';
import Patient from '../models/Patient.js';
import Service from '../models/Service.js';
import { protect, authorize } from '../middleware/auth.js';
import { checkPaymentEligibility, checkVisitActive } from '../middleware/paymentEligibility.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Protect all routes in this file
router.use(protect);

// @desc    Get all active visits (or doctor's own queue) and allow search by patient name
// @route   GET /api/visits
router.get('/', authorize('admin', 'doctor', 'receptionist'), async (req, res) => {
    try {
        const { search } = req.query;
        
        const query = { isActive: true };

        if (req.user.role === 'doctor') {
            query.doctor = req.user.id;
        }

        let visits;

        if (search) {
            const Patient = mongoose.model('Patient');
            const patientSearchRegex = new RegExp(search, 'i');

            const matchingPatients = await Patient.find({
                $or: [
                    { firstName: { $regex: patientSearchRegex } },
                    { lastName: { $regex: patientSearchRegex } }
                ]
            }).select('_id');

            const patientIds = matchingPatients.map(p => p._id);

            query.patient = { $in: patientIds };
        }

        visits = await Visit.find(query)
            .populate('patient', 'firstName lastName fullName') 
            .populate('doctor', 'firstName lastName fullName')
            .sort({ visitDate: -1 });

        res.status(200).json({ status: 'success', data: visits });
    } catch (error) {
        logger.error('Get visits error:', error);
        res.status(500).json({ status: 'error', message: 'Server Error' });
    }
});

// @desc    Get a single visit by ID with payment summary
// @route   GET /api/visits/:id
router.get('/:id', authorize('admin', 'doctor', 'receptionist'), async (req, res) => {
    try {
        const visit = await Visit.findById(req.params.id)
            .populate('patient')
            .populate('doctor');
        if (!visit) {
            return res.status(404).json({ status: 'error', message: 'Visit not found' });
        }
        
        // Include payment summary
        const paymentSummary = visit.getPaymentSummary();
        
        res.status(200).json({ 
            status: 'success', 
            data: visit,
            paymentSummary 
        });
    } catch (error) {
        logger.error('Get single visit error:', error);
        res.status(500).json({ status: 'error', message: 'Server Error' });
    }
});

// @desc    Create a new visit
// @route   POST /api/visits
// @access  Private (Admin, Receptionist)
router.post('/', authorize('admin', 'receptionist'), async (req, res) => {
  try {
    const { patientId, doctorId, visitDate, reason, status, type } = req.body;

    const activeVisit = await Visit.findOne({ 
        patient: patientId, 
        isActive: true
    });

    if (activeVisit) {
      return res.status(400).json({
        status: 'error',
        message: `Patient already has an active visit (Visit ID: ${activeVisit.visitId || activeVisit._id}). Please end the current visit before starting a new one.`
      });
    }

    // Fetch patient to check insurance status
    const patient = await Patient.findById(patientId);
    if (!patient) {
      return res.status(404).json({
        status: 'error',
        message: 'Patient not found'
      });
    }

    // Check if patient has insurance
    const hasInsurance = !!(patient.insurance?.provider);

    // Determine initial status based on insurance
    let visitStatus = status || 'Pending Payment';
    if (hasInsurance) {
      visitStatus = 'In Queue';
    }
    
    const newVisit = new Visit({
      patient: patientId,
      doctor: doctorId,
      visitDate,
      reason,
      status: visitStatus,
      type,
      startedBy: req.user.id,
    });

    const visit = await newVisit.save();

    logger.info(`Visit created for patient ${patientId}. Insurance status: ${hasInsurance}, Visit status: ${visitStatus}`);

    res.status(201).json({
      status: 'success',
      data: visit,
      message: `Visit created successfully${hasInsurance ? ' and moved to In Queue (insurance coverage)' : '. Payment is required before services can be ordered.'}`
    });
  } catch (error) {
    logger.error('Create visit error:', error);
    res.status(400).json({ status: 'error', message: error.message });
  }
});

// @desc    Add a lab order to a visit with automatic charge tracking
// @route   POST /api/visits/:id/lab-orders
// @access  Private (Doctor only)
router.post('/:id/lab-orders', 
  authorize('admin', 'doctor'), 
  checkPaymentEligibility,
  checkVisitActive,
  async (req, res) => {
    try {
        const visit = req.visit;
        const hasInsurance = req.hasInsurance;
        const { testName, notes } = req.body;

        // Look up service price
        let servicePrice = 0;
        try {
          const service = await Service.findOne({ 
            name: testName,
            category: 'Lab Test'
          });
          
          if (service) {
            servicePrice = service.price;
          }
        } catch (error) {
          logger.error('Error looking up service price:', error);
        }

        const newLabOrder = {
            testName,
            notes,
            patient: visit.patient._id,
            orderedBy: req.user.id,
            status: 'Pending',
            price: servicePrice,
            paymentStatus: hasInsurance ? 'insurance_claimed' : 'pending'
        };

        visit.labOrders.push(newLabOrder);
        
        // Add service charge if price found
        if (servicePrice > 0) {
          const insuranceCoveragePercentage = hasInsurance ? 80 : 0;
          
          visit.addServiceCharge({
            serviceType: 'lab_test',
            serviceName: testName,
            serviceId: visit.labOrders[visit.labOrders.length - 1]._id,
            price: servicePrice,
            quantity: 1,
            hasInsurance,
            insuranceCoveragePercentage,
            notes
          }, req.user.id);
        }
        
        await visit.save();

        const addedOrder = visit.labOrders[visit.labOrders.length - 1];
        
        logger.info(`Lab order added to visit ${visit.visitId} by ${req.user.firstName} ${req.user.lastName}`);
        
        res.status(201).json({ 
            status: 'success', 
            data: addedOrder,
            chargeInfo: servicePrice > 0 ? {
              price: servicePrice,
              hasInsurance,
              patientResponsibility: hasInsurance ? servicePrice * 0.2 : servicePrice
            } : null
        });

    } catch (error) {
        logger.error('Add lab order error:', error);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

// @desc    Add a prescription to a visit with automatic charge tracking
// @route   POST /api/visits/:id/prescriptions
// @access  Private (Doctor only)
router.post('/:id/prescriptions', 
  authorize('admin', 'doctor'),
  checkPaymentEligibility,
  checkVisitActive,
  async (req, res) => {
    try {
        const visit = req.visit;
        const hasInsurance = req.hasInsurance;
        const { medication, dosage, frequency, duration } = req.body;

        // Look up medication price
        let medicationPrice = 0;
        try {
          const service = await Service.findOne({ 
            name: medication,
            // Assuming medications are in a 'Medication' or 'Pharmacy' category
            $or: [
              { category: 'Medication' },
              { category: 'Pharmacy' }
            ]
          });
          
          if (service) {
            medicationPrice = service.price;
          }
        } catch (error) {
          logger.error('Error looking up medication price:', error);
        }

        const newPrescription = {
            medication,
            dosage,
            frequency,
            duration,
            patient: visit.patient._id,
            prescribedBy: req.user.id,
            price: medicationPrice,
            paymentStatus: hasInsurance ? 'insurance_claimed' : 'pending'
        };

        visit.prescriptions.push(newPrescription);
        
        // Add service charge if price found
        if (medicationPrice > 0) {
          const insuranceCoveragePercentage = hasInsurance ? 70 : 0; // Example: 70% coverage for meds
          
          visit.addServiceCharge({
            serviceType: 'prescription',
            serviceName: medication,
            serviceId: visit.prescriptions[visit.prescriptions.length - 1]._id,
            price: medicationPrice,
            quantity: 1,
            hasInsurance,
            insuranceCoveragePercentage,
            notes: `${dosage}, ${frequency}${duration ? ', ' + duration : ''}`
          }, req.user.id);
        }
        
        await visit.save();

        const addedPrescription = visit.prescriptions[visit.prescriptions.length - 1];
        
        logger.info(`Prescription added to visit ${visit.visitId} by ${req.user.firstName} ${req.user.lastName}`);
        
        res.status(201).json({ 
            status: 'success', 
            data: addedPrescription,
            chargeInfo: medicationPrice > 0 ? {
              price: medicationPrice,
              hasInsurance,
              patientResponsibility: hasInsurance ? medicationPrice * 0.3 : medicationPrice
            } : null
        });

    } catch (error) {
        logger.error('Add prescription error:', error);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

// @desc    Record a payment for a visit
// @route   POST /api/visits/:id/payments
// @access  Private (Admin, Receptionist)
router.post('/:id/payments',
  authorize('admin', 'receptionist'),
  async (req, res) => {
    try {
      const visit = await Visit.findById(req.params.id);
      
      if (!visit) {
        return res.status(404).json({
          status: 'error',
          message: 'Visit not found'
        });
      }

      const { amount, paymentMethod, paymentType, receiptNumber, transactionId, notes } = req.body;

      if (!amount || !paymentMethod || !paymentType) {
        return res.status(400).json({
          status: 'error',
          message: 'Amount, payment method, and payment type are required'
        });
      }

      visit.recordPayment({
        amount,
        paymentMethod,
        paymentType,
        receiptNumber,
        transactionId,
        notes
      }, req.user.id);

      await visit.save();

      logger.info(`Payment recorded for visit ${visit.visitId}: $${amount} via ${paymentMethod}`);

      res.status(201).json({
        status: 'success',
        message: 'Payment recorded successfully',
        data: visit.getPaymentSummary()
      });
    } catch (error) {
      logger.error('Record payment error:', error);
      res.status(400).json({
        status: 'error',
        message: error.message
      });
    }
});

// @desc    Get payment summary for a visit
// @route   GET /api/visits/:id/payment-summary
// @access  Private
router.get('/:id/payment-summary',
  authorize('admin', 'doctor', 'receptionist'),
  async (req, res) => {
    try {
      const visit = await Visit.findById(req.params.id)
        .populate('patient', 'firstName lastName patientId insurance');
      
      if (!visit) {
        return res.status(404).json({
          status: 'error',
          message: 'Visit not found'
        });
      }

      const paymentSummary = visit.getPaymentSummary();

      res.status(200).json({
        status: 'success',
        data: paymentSummary
      });
    } catch (error) {
      logger.error('Get payment summary error:', error);
      res.status(500).json({
        status: 'error',
        message: 'Server Error'
      });
    }
});

// @desc    Update visit payment status (for receptionists to confirm payment)
// @route   PATCH /api/visits/:id/payment-status
// @access  Private (Admin, Receptionist)
router.patch('/:id/payment-status', 
  authorize('admin', 'receptionist'), 
  async (req, res) => {
    try {
        const { paymentConfirmed } = req.body;
        const visit = await Visit.findById(req.params.id).populate('patient');

        if (!visit) {
            return res.status(404).json({
                status: 'error',
                message: 'Visit not found'
            });
        }

        // Only update if currently pending payment
        if (visit.status === 'Pending Payment' && paymentConfirmed) {
            visit.status = 'In Queue';
            visit.consultationFeePaid = true;
            await visit.save();

            logger.info(`Payment confirmed for visit ${visit.visitId}. Status changed to In Queue.`);

            return res.status(200).json({
                status: 'success',
                message: 'Payment confirmed. Visit moved to queue.',
                data: visit
            });
        }

        res.status(400).json({
            status: 'error',
            message: 'Visit is not in Pending Payment status or payment already confirmed'
        });
    } catch (error) {
        logger.error('Update payment status error:', error);
        res.status(500).json({
            status: 'error',
            message: 'Server Error'
        });
    }
});

// @desc    Get visits with outstanding payments
// @route   GET /api/visits/outstanding-payments
// @access  Private (Admin, Receptionist)
router.get('/reports/outstanding-payments',
  authorize('admin', 'receptionist'),
  async (req, res) => {
    try {
      const visits = await Visit.getVisitsWithOutstandingPayments();
      
      res.status(200).json({
        status: 'success',
        count: visits.length,
        data: visits
      });
    } catch (error) {
      logger.error('Get outstanding payments error:', error);
      res.status(500).json({
        status: 'error',
        message: 'Server Error'
      });
    }
});

// @desc    Add a diagnosis to a visit
// @route   POST /api/visits/:id/diagnosis
// @access  Private (Doctor only)
router.post('/:id/diagnosis', authorize('admin', 'doctor'), async (req, res) => {
    try {
        const visit = await Visit.findById(req.params.id);

        if (!visit) {
            return res.status(404).json({ status: 'error', message: 'Visit not found' });
        }

        const { condition, icd10Code, notes } = req.body;

        const newDiagnosis = {
            condition,
            icd10Code,
            notes,
            patient: visit.patient._id,
            diagnosedBy: req.user.id,
        };

        visit.diagnosis.push(newDiagnosis);
        await visit.save();

        const addedDiagnosis = visit.diagnosis[visit.diagnosis.length - 1];
        res.status(201).json({ status: 'success', data: addedDiagnosis });

    } catch (error) {
        logger.error('Add diagnosis error:', error);
        res.status(400).json({ status: 'error', message: error.message });
    }
});

// @desc    End a visit
// @route   PATCH /api/visits/:id/end-visit
router.patch('/:id/end-visit', authorize('admin', 'receptionist'), async (req, res) => {
    try {
        const visit = await Visit.findById(req.params.id);

        if (!visit) {
            res.status(404).json({
                status: 'error',
                message: 'Visit not found'
            });
        }

        visit.isActive = !visit.isActive;
        await visit.save();

        res.status(200).json({
            status: 'success',
            message: `Visit ${visit.isActive} ended successfully`
        });
    } catch (error) {
        logger.error('Ending visit error', error);
        res.status(500).json({
            status: 'error',
            message: 'Server Error'
        });
    }
});

// @desc    Update a visit with clinical data
// @route   PUT /api/visits/:id/clinical
router.put('/:id/clinical', authorize('doctor'), async (req, res) => {
    try {
        const visit = await Visit.findById(req.params.id);
        if (!visit) {
            return res.status(404).json({ message: 'Visit not found' });
        }

        const { diagnosis, labOrders, prescriptions } = req.body;

        if (diagnosis) visit.diagnosis = diagnosis;
        if (labOrders) visit.labOrders.push(...labOrders);
        if (prescriptions) visit.prescriptions.push(...prescriptions);
        
        if(req.body.status) visit.status = req.body.status;

        await visit.save();
        res.status(200).json({ status: 'success', data: visit });

    } catch (error) {
        logger.error('Update clinical data error:', error);
        res.status(400).json({ message: 'Failed to update clinical data', error: error.message });
    }
});

export default router;