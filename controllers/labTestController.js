import LabTest from '../models/LabTest.js';
import Visit from '../models/Visit.js';
import Service from '../models/Service.js'; // Assuming you have a Service model
import logger from '../utils/logger.js';

// @desc    Get all lab tests
// @route   GET /api/lab-tests
// @access  Private
export const getLabTests = async (req, res) => {
  try {
    const labTests = await LabTest.find().populate('patient').populate('orderedBy');
    res.status(200).json({ 
      success: true, 
      data: labTests 
    });
  } catch (error) {
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
};

// @desc    Get single lab test
// @route   GET /api/lab-tests/:id
// @access  Private
export const getLabTest = async (req, res) => {
  try {
    const labTest = await LabTest.findById(req.params.id).populate('patient').populate('orderedBy');
    if (!labTest) {
      return res.status(404).json({ 
        success: false, 
        message: 'Lab test not found' 
      });
    }
    res.status(200).json({ 
      success: true, 
      data: labTest 
    });
  } catch (error) {
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
};


// @desc    Create a lab test (usually part of a visit)
// @route   POST /api/lab-tests
// @access  Private
export const createLabTest = async (req, res) => {
  try {
    const { orderData, patient, visit: visitId } = req.body;
    
    // Visit is already populated by middleware
    const visit = req.visit;
    const hasInsurance = req.hasInsurance;
    
    // Look up the service price
    let servicePrice = 0;
    let service = null;
    
    try {
      service = await Service.findOne({ 
        name: orderData.testName,
        category: 'Lab Test'
      });
      
      if (service) {
        servicePrice = service.price;
      } else {
        logger.warn(`Service price not found for lab test: ${orderData.testName}`);
      }
    } catch (error) {
      logger.error('Error looking up service price:', error);
    }
    
    // Create the lab test
    const labTest = await LabTest.create({
      testName: orderData.testName,
      notes: orderData.notes,
      patient,
      visit: visitId,
      orderedBy: req.user.id
    });
    
    // Add service charge to visit if visit exists and price was found
    if (visit && servicePrice > 0) {
      // Determine insurance coverage (you can customize this logic)
      const insuranceCoveragePercentage = hasInsurance ? 80 : 0; // Example: 80% coverage
      
      visit.addServiceCharge({
        serviceType: 'lab_test',
        serviceName: orderData.testName,
        serviceId: labTest._id,
        price: servicePrice,
        quantity: 1,
        hasInsurance,
        insuranceCoveragePercentage,
        notes: orderData.notes
      }, req.user.id);
      
      await visit.save();
      
      logger.info(`Service charge added for lab test: ${orderData.testName} - $${servicePrice}`);
    }
    
    res.status(201).json({ 
      success: true, 
      data: labTest,
      chargeInfo: servicePrice > 0 ? {
        price: servicePrice,
        hasInsurance,
        patientResponsibility: hasInsurance ? servicePrice * 0.2 : servicePrice
      } : null
    });
  } catch (error) {
    logger.error('Create lab test error:', error);
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
};

// @desc    Update a lab test with results
// @route   PUT /api/lab-tests/:id
// @access  Private (Lab Technician)
export const updateLabTest = async (req, res) => {
  try {
    const { results, status } = req.body;
    const labTest = await LabTest.findByIdAndUpdate(
      req.params.id,
      { results, status, completedAt: Date.now() },
      { new: true, runValidators: true }
    );

    if (!labTest) {
      return res.status(404).json({ 
        success: false, 
        message: 'Lab test not found' 
      });
    }

    res.status(200).json({ 
      success: true, 
      data: labTest 
    });
  } catch (error) {
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
};