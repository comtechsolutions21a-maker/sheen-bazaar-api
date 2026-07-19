const express = require('express');
const Product = require('../models/Product');
const User = require('../models/User');
const ResellerListing = require('../models/ResellerListing');

const router = express.Router();

// GET /api/products?cat=Fashion&search=saree&sort=price-low&minPrice=0&maxPrice=600
router.get('/', async (req, res) => {
  try {
    const { cat, search, sort, minPrice, maxPrice } = req.query;
    const filter = { active: true };

    if (cat && cat !== 'All') filter.cat = cat;
    if (search) filter.name = { $regex: search, $options: 'i' };
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    let query = Product.find(filter);
    if (sort === 'price-low') query = query.sort({ price: 1 });
    if (sort === 'price-high') query = query.sort({ price: -1 });

    const products = await query.exec();
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch products', error: err.message });
  }
});

// GET /api/products/categories
router.get('/categories', async (req, res) => {
  const cats = await Product.distinct('cat');
  res.json(cats);
});

// GET /api/products/reseller/:resellerId — a reseller's public storefront:
// their active listings, priced at whatever they set, joined with product info.
router.get('/reseller/:resellerId', async (req, res) => {
  const reseller = await User.findOne({ _id: req.params.resellerId, role: 'reseller' });
  if (!reseller) return res.status(404).json({ message: 'Reseller not found' });

  const listings = await ResellerListing.find({ reseller: reseller._id, active: true });
  const productIds = listings.map((l) => l.productId);
  const products = await Product.find({ id: { $in: productIds }, active: true });
  const productMap = new Map(products.map((p) => [p.id, p]));

  const items = listings
    .map((l) => {
      const product = productMap.get(l.productId);
      if (!product) return null;
      return { product, resellPrice: l.resellPrice };
    })
    .filter(Boolean);

  res.json({ reseller: { id: reseller._id, name: reseller.name, businessName: reseller.businessName }, items });
});

// GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findOne({ id: Number(req.params.id), active: true });
    if (!product) return res.status(404).json({ message: 'Product not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch product', error: err.message });
  }
});

// GET /api/products/:id/related
router.get('/:id/related', async (req, res) => {
  const product = await Product.findOne({ id: Number(req.params.id), active: true });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  const related = await Product.find({ cat: product.cat, id: { $ne: product.id }, active: true }).limit(6);
  res.json(related);
});

module.exports = router;
