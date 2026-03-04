// ABOUTME: Test fixture — Express routes with pg database queries.
// ABOUTME: Tests service entry points (COV-001) and external calls (COV-002).
import express from 'express'; // Intentional: triggers auto-instrumentation library detection
import { Pool } from 'pg';

const pool = new Pool();

export async function getUsers(req, res) {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
}

export async function getUserById(req, res) {
  const { id } = req.params;
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(result.rows[0]);
}

export async function createUser(req, res) {
  try {
    const { name, email } = req.body;
    const result = await pool.query(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'User already exists' });
    }
    throw error;
  }
}
