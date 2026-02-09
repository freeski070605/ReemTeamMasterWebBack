import express from 'express';
import Table from '../models/Table';

const router = express.Router();

// GET /api/tables
router.get('/', async (req, res) => {
  try {
    const tables = await Table.find().sort({ stake: 1 }); // Sort by stake, ascending
    res.json(tables);
  } catch (error) {
    console.error('Error fetching tables:', error);
    res.status(500).json({ message: 'Server error fetching tables' });
  }
});

export default router;
