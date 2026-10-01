# Transcript Anáhuac

**Extract, analyze, and code qualitative conversations from ChatGPT transcripts**

[![Apache 2.0 License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-18%2B-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/python-3.9%2B-blue.svg)](https://www.python.org/)

This repository provides a complete pipeline for extracting and analyzing ChatGPT conversations at scale. It combines an automated transcript extraction tool with a qualitative coding framework for analyzing self-regulated learning and metacognitive processes in LLM interactions.

**Two complementary components:**

1. **Transcript Extractor** — Automated web tool to download and store ChatGPT conversations
2. **Metacognitive Process Analysis Architecture** — Qualitative coding framework for analyzing learning behaviors in those conversations

## Quick Start

**Just need the extractor?** → See `/Deployment & API` section  
**Just need the codebook?** → See `/codebook/README_CODEBOOK.md`  
**Want the full pipeline?** → Keep reading

---

## Part 1: Transcript Extraction & Storage

### What It Does

- Downloads complete ChatGPT conversations from shared links
- Extracts metadata (timestamps, participants, turn structure)
- Stores everything in MongoDB for analysis
- Generates Word documents for review
- Delivers `.zip` files with batch results

### Architecture

```
Frontend (React)
      ↓
Backend (Python/Flask)
      ↓
Extractor (Node.js + Playwright)
      ↓
MongoDB (persistent storage)
```

### Tech Stack

| Component | Tech |
|-----------|------|
| Backend | Python 3.9+, Flask |
| Extractor | Node.js 18+, Playwright |
| Database | MongoDB Atlas (cloud) |
| Frontend | React |
| Container | Docker |
| Deploy | Render, Heroku, or any Docker host |

### Setup (Development)

**Prerequisites:**

- Node.js 18+
- Python 3.9+
- MongoDB Atlas account (free tier available)

**Install:**

```bash
git clone https://github.com/josuerodriquezs-star/transcript-anáhuac.git
cd transcript-anáhuac

# Backend
pip install -r requirements.txt

# Frontend
cd frontend
npm install
```

**Environment variables** (`.env`):

```bash
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/
MONGODB_DB_NAME=transcripts
MONGODB_COLLECTION_NAME=conversaciones
ALLOWED_ORIGIN=http://localhost:3000
FLASK_ENV=development
```

**Run locally:**

```bash
# Terminal 1: Backend
python app.py

# Terminal 2: Frontend
cd frontend && npm start
```

Check:
- Frontend: [http://localhost:3000](http://localhost:3000)
- Backend: [http://localhost:5000/health](http://localhost:5000/health)

### Deployment (Production)

**Push to GitHub:**

```bash
git add .
git commit -m "Ready for production"
git push origin main
```

**Deploy on Render:**

1. Create Web Service on [render.com](https://render.com)
2. Connect your GitHub repo
3. Runtime: Docker
4. Add environment variables (same as `.env` above)
5. Deploy

Render auto-detects `Dockerfile` and deploys. Your app runs at `https://your-app.onrender.com`

### API Reference

**`POST /generate`**

Extract transcripts from ChatGPT links.

Request:

```json
{
  "curso": "Applied AI in Education",
  "clave_materia": "COM4512",
  "programa": "Computer Science",
  "arranque": "2024-Fall",
  "actividad_nombre": "Claude Conversation Analysis",
  "actividad_numero": "Activity 3",
  "fecha_limite": "2024-10-30",
  "alumnos": [
    {
      "nombre": "Smith, John",
      "link": "https://chatgpt.com/share/abc123xyz",
      "fecha_envio": "2024-10-30 10:00"
    }
  ]
}
```

Response: `.zip` file containing one `.docx` per student + metadata JSON

**`GET /health`**

Check service status.

```json
{
  "status": "ok",
  "mongodb": "connected"
}
```

---

## Part 2: Metacognitive Process Analysis Architecture

### What It Is

A **qualitative coding framework** for analyzing self-regulated learning (SRL) in LLM conversations. It operationalizes four phases of learning regulation (Zimmerman, 2002) with linguistic patterns, decision rules, and empirically-derived corrective layers.

**Use this when you have conversation transcripts and want to analyze:**

- Planning and strategy setting
- Monitoring of comprehension and progress
- Evaluation of quality and relevance
- Adaptation and metacognitive adjustment

### Why It Matters

LLMs can facilitate or inhibit learning depending on how students interact. This framework lets you code *actual self-regulated learning behaviors*, not just task completion. It distinguishes between:

- Asking ChatGPT to think (≠ student thinking)
- Students using ChatGPT to verify their own ideas (= self-regulation)
- Students blindly accepting outputs (≠ metacognition)

### The Framework

**Four Core Phases** (based on Zimmerman's cyclical model):

| Phase | Definition | Example |
|-------|-----------|---------|
| **Planning** | Anticipation, goal-setting, strategic setup | "Before I write, let me map out my argument against two sources" |
| **Monitoring** | Checking comprehension, progress, quality | "Is this claim actually supported by the paper?" |
| **Evaluation** | Judging results against criteria | "This is too general; it doesn't meet the rubric" |
| **Adaptation** | Adjusting strategy based on feedback | "Let me reframe using my voice, not academic jargon" |

**Corrective Layers:**

1. **Pilot audit layer** — Fixes false positives from manual review of 50 turns
2. **Second sample layer** — Addresses inconsistencies from 282-turn sample
3. **Global rules** — Evidence hierarchy, linguistic patterns, decision thresholds

### How to Use It

**For researchers / instructors:**

1. Extract conversations using the Transcript Extractor (Part 1)
2. Download MongoDB data or export JSON
3. Point the codebook YAML at your conversations
4. Run codification against local LLM (Ollama, vLLM, etc.)
5. Analyze output patterns

**For developers:**

- Template codebook: `/codebook/codebook_template.yaml`
- Examples: `/codebook/examples/`
- Integration guide: `/codebook/README_CODEBOOK.md`
- Python starter script: `/codebook/tools/codify.py`

### File Structure (Codebook Section)

```
codebook/
├── README_CODEBOOK.md              # Full documentation
├── codebook_template.yaml          # The framework (YAML)
├── examples/
│   ├── example_conversation.json   # Sample input
│   ├── example_output.json         # Sample coded output
│   └── readme_examples.md          # Walkthrough
└── tools/
    ├── codify.py                   # Python script to run codification
    └── process_results.py          # Post-process results
```

### Quick Example

**Input conversation turn:**

```
User: "I'm not sure this argument is supported by the theory. 
Can you check the original paper I uploaded?"
```

**Codebook output:**

```yaml
Categorias_Autorregulacion: ["Monitoreo", "Adaptacion"]
Confianza: "Alta"
Evidencia_Monitoreo: "User explicitly questions theoretical support"
Evidencia_Adaptacion: "User seeks to verify against primary source"
Justificacion: "User detects potential rigor issue and adapts strategy"
Requiere_Revision: "No"
```

---

## Workflow: Extract → Codify → Analyze

```
Step 1: Extract
  ├─ Use frontend to upload student ChatGPT links
  ├─ Backend downloads transcripts via Playwright
  └─ Store in MongoDB + generate .docx files

         ↓

Step 2: Export
  ├─ Download from MongoDB as JSON
  └─ Organize conversations by course/activity

         ↓

Step 3: Codify (Local)
  ├─ Run codebook against conversations
  ├─ Use local LLM (Ollama) or API (Claude, GPT)
  └─ Generate coding CSV + confidence scores

         ↓

Step 4: Analyze
  ├─ Calculate SRL patterns per student
  ├─ Identify learning cycles (Plan → Monitor → Evaluate → Adapt)
  ├─ Compare across groups/courses
  └─ Export for research, reports, or feedback
```

---

## For Educators

**Use Case 1: Audit student work**

- Extract ChatGPT conversations automatically
- Review Word docs for quality/originality
- Flag concerning patterns (e.g., "user didn't monitor their work")

**Use Case 2: Research on AI-supported learning**

- Extract all conversations from a course
- Codify with the Metacognitive Process Architecture
- Analyze: Which students self-regulate? Which don't?
- Correlate with grades, attendance, final outcomes

**Use Case 3: Institutional data collection**

- Run extractor at end of semester
- Collect all ChatGPT interactions per course
- Store in MongoDB for longitudinal analysis
- Build dashboards of learning behaviors over time

---

## For Researchers

**The codebook is publication-ready:**

- Grounded in Zimmerman's self-regulated learning theory
- Operationalized with linguistic patterns and decision rules
- Validated on ~350 turns of academic conversation
- Designed to minimize false positives (prioritizes specificity)
- Documented with examples and edge cases

**Reuse / adapt:**

- Template YAML is language-agnostic (patterns can be translated)
- Easy to extend with new categories or contextual rules
- Open source (Apache 2.0) — no licensing restrictions

See `/codebook/README_CODEBOOK.md` for full methodology.

---

## Repository Structure

```
transcript-anáhuac/
├── README.md (this file)
├── LICENSE (Apache 2.0)
├── Dockerfile
├── docker-compose.yml (optional)
├── .env.example
│
├── # Extraction Pipeline
├── app.py
├── requirements.txt
├── extractor_v4_playwright.js
├── frontend/
│   ├── package.json
│   ├── public/
│   └── src/
│       ├── App.js
│       ├── components/
│       └── ...
│
└── # Analysis & Coding
    ├── README_CODEBOOK.md
    ├── codebook_template.yaml
    ├── examples/
    │   ├── example_conversation.json
    │   ├── example_output.json
    │   └── readme_examples.md
    └── tools/
        ├── codify.py
        └── process_results.py
```

---

## Examples

### Example 1: Extract one student's work

```bash
curl -X POST http://localhost:5000/generate \
  -H "Content-Type: application/json" \
  -d '{
    "curso": "AI Ethics",
    "clave_materia": "PHIL3801",
    "programa": "Philosophy",
    "arranque": "2024-Fall",
    "actividad_nombre": "ChatGPT Limitations",
    "actividad_numero": "Assignment 2",
    "fecha_limite": "2024-10-15",
    "alumnos": [{
      "nombre": "García, María",
      "link": "https://chatgpt.com/share/abc123xyz",
      "fecha_envio": "2024-10-15 09:30"
    }]
  }' -o result.zip
```

### Example 2: Analyze a conversation with the codebook

```bash
python codebook/tools/codify.py \
  --conversation examples/example_conversation.json \
  --codebook codebook_template.yaml \
  --model ollama:mistral \
  --output results.csv
```

---

## Development

### Add new features

1. Fork the repo
2. Create a branch: `git checkout -b feature/my-feature`
3. Commit: `git commit -m "Add feature"`
4. Push & open a PR

### Debug backend

```bash
FLASK_ENV=development python app.py
```

### Debug frontend

```bash
cd frontend
npm start
```

### Test extraction

```bash
node extractor_v4_playwright.js "https://chatgpt.com/share/..."
```

---

## Known Limitations

- ChatGPT links must be publicly shared
- Large conversations (1000+ turns) may take time to extract
- MongoDB Atlas free tier: 512 MB (enough for ~10k conversations)
- Playwright needs ~500 MB RAM per concurrent extraction

---

## Roadmap

- [ ] Support Claude.ai conversation shares
- [ ] Dashboard for viewing coded conversations
- [ ] Export to Google Classroom / Canvas
- [ ] Automatic feedback generation based on SRL patterns
- [ ] Multi-language support (codebook translation)
- [ ] Integration with learning management systems (LMS)

---

## License

Apache 2.0 — see [LICENSE](LICENSE)

**Copyright 2026** Josué Salvador Rodríguez Sánchez

---

## Citation

If you use this framework for research, please cite:

```bibtex
@software{rodriguez_transcript_anáhuac_2026,
  author = {Rodríguez Sánchez, Josué Salvador},
  title = {Transcript Anáhuac: Extraction and Qualitative Analysis of LLM Conversations},
  year = {2026},
  url = {https://github.com/josuerodriquezs-star/transcript-anáhuac},
  license = {Apache-2.0}
}
```

---

## Support & Feedback

- **Issues**: [GitHub Issues](https://github.com/josuerodriquezs-star/transcript-anáhuac/issues)
- **Email**: josue.rodriguezs@universidad.anahuac.mx
- **Codebook questions**: See `/codebook/README_CODEBOOK.md`

---

Made with ❤️ for education research and learning analytics.
