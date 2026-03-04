// ABOUTME: Test fixture — JavaScript file with no OTel imports and various function types
import express from 'express';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';

const app = express();
const pool = new Pool();

export async function getUsers(req, res) {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
}

export async function getUserById(req, res) {
  const { id } = req.params;
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json(result.rows[0]);
}

export function formatUser(user) {
  return {
    id: user.id,
    name: `${user.first_name} ${user.last_name}`,
    email: user.email,
  };
}

function validateInput(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid input');
  }
  return true;
}

async function loadConfig() {
  const content = await readFile('./config.json', 'utf-8');
  return JSON.parse(content);
}
