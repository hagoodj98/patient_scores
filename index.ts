import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = 3000;
const host = 'https://assessment.ksensetech.com';

type Patient = {
    patient_id: string,
    name: string,
    age: number,
    gender: string,
    blood_pressure: string,
    temperature: number,
    visit_date: string,
    diagnosis: string,
    medications: string,
}
type AlertCategory = {
  high_risk_patients: string[];
  fever_patients: string[];
  data_quality_issues: string[];
};

type AlertCategorySets = {
  high_risk_patients: Set<string>;
  fever_patients: Set<string>;
  data_quality_issues: Set<string>;
};

const checkIfNumber = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

let results: AlertCategory | null = null;

const parseBloodPressure = (bp: unknown): { systolic: number; diastolic: number } | null => {
  if (typeof bp !== 'string') return null;
  const parts = bp.split('/');
  if (parts.length !== 2) return null;
  const systolic = Number(parts[0]);
  const diastolic = Number(parts[1]);
  if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return null;
  return { systolic, diastolic };
};

const bpRiskScore = (systolic: number, diastolic: number): number => {
  // Systolic stage
  const systolicScore = systolic < 120 ? 0 : systolic <= 129 ? 1 : systolic <= 139 ? 2 : 3; // >= 140

  // Diastolic stage
  const diastolicScore = diastolic < 80 ? 0 : diastolic <= 89 ? 2 : 3; // >= 90

  // If they fall into different categories, use the higher risk stage
  return Math.max(systolicScore, diastolicScore);
};

const temperatureRiskScore = (temp: number): number => {
  if (temp <= 99.5) return 0;
  if (temp >= 99.6 && temp <= 100.9) return 1;
  return 2; // >= 101.0
};

const ageRiskScore = (age: number): number => {
  if (age < 40) return 0;
  if (age >= 40 && age <= 65) return 1;
  return 2; // > 65
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

app.get('/', async (req, res) => {
  // Move alertCategories outside the retry function
  const alertCategories: AlertCategorySets = {
    high_risk_patients: new Set<string>(),
    fever_patients: new Set<string>(),
    data_quality_issues: new Set<string>(),
  };

  const getPatients = async (retryCount = 0): Promise<void> => {
    const maxRetries = 3;
    try {
      const limit = 20;
      let page = 1;
      const patients: Patient[] = [];

      while (true) {
        const pageResp = await axios.get(`${host}/api/patients?page=${page}&limit=${limit}`, {
          headers: {
            'x-api-key': process.env.API_KEY,
          },
        });

        const pagePatients: Patient[] = pageResp.data?.data ?? pageResp.data;

        if (!Array.isArray(pagePatients) || pagePatients.length === 0) {
          break;
        }

        patients.push(...pagePatients);

        // If the API returned fewer than the page size, we're at the end.
        if (pagePatients.length < limit) {
          break;
        }

        page += 1;
      }

      patients.forEach(patient => {
        let riskScore = 0;
        // Calculate Blood Pressure Score (explicit validation; invalid values won't throw, they become NaN)
        const bp = parseBloodPressure(patient.blood_pressure);
        if (bp === null) {
          alertCategories.data_quality_issues.add(patient.patient_id);
        } else {
          const { systolic, diastolic } = bp;
          riskScore += bpRiskScore(systolic, diastolic);
        }
        // Calculate Temperature Score
        const temp = checkIfNumber(patient.temperature);
        if (temp === null) {
          alertCategories.data_quality_issues.add(patient.patient_id);
        } else {
          riskScore += temperatureRiskScore(temp);
        }
        // Calculate Age Score
        const age = checkIfNumber(patient.age);
        if (age === null) {
          alertCategories.data_quality_issues.add(patient.patient_id);
        } else {
          riskScore += ageRiskScore(age);
        }
        //add patient IDs to respective alert categories based on risk score and temperature
        if (riskScore >= 4) {
          alertCategories.high_risk_patients.add(patient.patient_id);
        }
        if (temp !== null && temp >= 99.6) {
          alertCategories.fever_patients.add(patient.patient_id);
        }
      });

      return;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // Handle 429 Too Many Requests
        if (error.response?.status === 429) {
          if (retryCount < maxRetries) {
            const retryAfter = error.response.data?.retry_after || Math.pow(2, retryCount);
            const waitTime = retryAfter * 1000; // Convert to milliseconds
            console.log(`Rate limited (429). Retrying in ${waitTime}ms (attempt ${retryCount + 1}/${maxRetries})`);
            await delay(waitTime);
            return getPatients(retryCount + 1);
          } else {
            console.error('Max retries exceeded for rate limit');
            throw error;
          }
        }
        // Handle 5xx server errors
        if (error.response && error.response.status >= 500 && error.response.status <= 503) {
          if (retryCount < maxRetries) {
            const waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff
            console.log(`Server error (${error.response.status}). Retrying in ${waitTime}ms (attempt ${retryCount + 1}/${maxRetries})`);
            await delay(waitTime);
            return getPatients(retryCount + 1);
          }
        }
      } else if (error instanceof Error) {
        console.log('Error:', error.message);
      }
      console.error('An unexpected error occurred:', error);
      throw error;
    }
  };

  try {
    await getPatients();

    results = {
      high_risk_patients: Array.from(alertCategories.high_risk_patients),
      fever_patients: Array.from(alertCategories.fever_patients),
      data_quality_issues: Array.from(alertCategories.data_quality_issues),
    };

    return res.json(results);
  } catch (error) {
    console.error('Failed to fetch patients:', error);
    res.status(500).json({ error: 'Failed to fetch patient data' });
  }
});

app.get('/check-results', async (req, res) => {
  try {
    if (!results) {
      return res.status(400).json({ error: 'No results found. Call / first to generate results.' });
    }

    const assessmentResults = await axios.post(
      `${host}/api/submit-assessment`,
      results,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.API_KEY,
        },
      }
    );

    return res.status(200).json(assessmentResults.data);
  } catch (error) {
    console.error('Failed to submit assessment:', error);
    if (axios.isAxiosError(error)) {
      return res.status(error.response?.status ?? 502).send(error.response?.data ?? { error: 'Submission failed' });
    }
    return res.status(502).json({ error: 'Submission failed' });
  }
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});