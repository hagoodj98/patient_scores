import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import e from 'express';

dotenv.config();

const app = express();
const port = 3000;
const host = 'https://assessment.ksensetech.com/api/patients';

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
    [key: string]: string[];
}

const checkIfNumber = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const parseBloodPressure = (bp: unknown): { systolic: number; diastolic: number } | null => {
  if (typeof bp !== 'string') return null;
  const parts = bp.split('/');
  if (parts.length !== 2) return null;
  const systolic = Number(parts[0]);
  const diastolic = Number(parts[1]);
  if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return null;
  return { systolic, diastolic };
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

app.get('/', async (req, res) => {
    const getPatients = async (retryCount = 0): Promise<AlertCategory> => {
        const alertCategories: AlertCategory = {
            "high_risk_patients": [],
            "fever_patients": [],
            "data_quality_issues": []
        };
        const maxRetries = 3;
        
        try {
            const results = await axios.get(`${host}?page=1&limit=20`, {
                headers: {
                    'x-api-key': process.env.API_KEY
                }
            });
            const patients: Patient[] = results.data.data || results.data;
            
            if (!Array.isArray(patients)) {
                console.error('Expected patients to be an array, but got:', typeof patients);
                if (retryCount < maxRetries) {
                    const waitTime = Math.pow(2, retryCount) * 1000;
                    console.log(`Invalid data structure. Retrying in ${waitTime}ms (attempt ${retryCount + 1}/${maxRetries})`);
                    await delay(waitTime);
                    return getPatients(retryCount + 1);
                } else {
                    throw new Error('Invalid patients data structure after max retries');
                }
            }
            
            console.log(patients, 'patients data');
            
            patients.forEach(patient => {
                let riskScore = 0;
                // Calculate Blood Pressure Score
                // Calculate Blood Pressure Score (explicit validation; invalid values won't throw, they become NaN)
                const bp = parseBloodPressure(patient.blood_pressure);
                if (!bp) {
                    alertCategories['data_quality_issues'].push(patient.patient_id);
                } else {
                    const { systolic, diastolic } = bp;
                    if (systolic < 120 && diastolic < 80) {
                        riskScore += 0;
                    } else if (systolic >= 120 && systolic <= 129 && diastolic < 80) {
                        riskScore += 1;
                    } else if ((systolic >= 130 && systolic <= 139) || (diastolic >= 80 && diastolic <= 89)) {
                        riskScore += 2;
                    } else {
                        riskScore += 3;
                    }
                }
                // Calculate Temperature Score
                const temp = checkIfNumber(patient.temperature);
                if (temp === null) {
                    alertCategories['data_quality_issues'].push(patient.patient_id);
                } else {
                    if (temp < 99.6) {
                        riskScore += 1;
                    } else {
                        riskScore += 2;
                    }
                }
            
                // Calculate Age Score
                const age = checkIfNumber(patient.age);
                if (age === null) {
                    alertCategories['data_quality_issues'].push(patient.patient_id);
                } else {
                    if (age < 40) {
                        riskScore += 0;
                    } else if (age >= 40 && age <= 65) {
                        riskScore += 1;
                    } else {
                        riskScore += 2;
                    }
                }
                //add patient IDs to respective alert categories based on risk score and temperature
                if (riskScore >= 4) {
                    alertCategories['high_risk_patients'].push(patient.patient_id);
                }
                if (temp !== null && temp >= 99.6) {
                    alertCategories['fever_patients'].push(patient.patient_id);
                }
            });
            
            return alertCategories;
            
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
    }
    
    try {
        const alertCategories = await getPatients();
        res.send(alertCategories);
    } catch (error) {
        console.error('Failed to fetch patients:', error);
        res.status(500).json({ error: 'Failed to fetch patient data' });
    }

});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});