# Metacognitive Process Analysis Architecture

**A qualitative coding framework for analyzing self-regulated learning in LLM conversations**

This is a comprehensive, empirically-grounded framework for coding how learners monitor, evaluate, and adapt their processes when interacting with large language models. It operationalizes Zimmerman's self-regulated learning (SRL) theory into four observable phases.

## Quick Links

- **Full YAML codebook**: `codebook_template.yaml`
- **Examples**: `examples/`
- **Python starter**: `tools/codify.py`

---

## What This Framework Does

It answers: **When students use ChatGPT, how much are they actually *thinking* vs. blindly accepting outputs?**

This framework lets you code actual self-regulatory behaviors:

- ✅ "I disagree with this because..." (Evaluation + Adaptation)
- ✅ "Let me verify this against the paper first" (Monitoring)
- ✅ "Before I write, I need to map my argument" (Planning)
- ❌ "Here's the essay ChatGPT wrote for me" (No self-regulation)

It distinguishes between:

| Behavior | Coded As |
|----------|----------|
| ChatGPT suggests something, student uses it as-is | No self-regulation |
| ChatGPT suggests something, student questions it | Monitoring |
| Student says "that doesn't match my rubric" | Evaluation |
| Student says "let me reframe using my voice" | Adaptation |

---

## The Theory: Zimmerman's Self-Regulated Learning Cycle

Zimmerman (2002) models SRL as a **cyclical process** with three phases:

1. **Forethought** — Planning, goal-setting, strategic anticipation
2. **Performance** — Monitoring progress and quality during execution
3. **Self-reflection** — Evaluating outcomes and adapting strategy

This framework expands that cycle into four observable phases in conversation:

```
┌─────────────┐
│ Planning    │ "Before I respond, let me..."
└──────┬──────┘
       ↓
┌─────────────┐
│ Monitoring  │ "Wait, let me check if..."
└──────┬──────┘
       ↓
┌─────────────┐
│ Evaluation  │ "This doesn't meet the rubric because..."
└──────┬──────┘
       ↓
┌─────────────┐
│ Adaptation  │ "Let me reframe this..."
└──────┬──────┘
       ↓
   (Cycle continues or ends)
```

---

## The Four Phases Explained

### 1. Planning (Forethought Phase)

**Definition**: User anticipates, organizes, or defines how to approach a task before requesting help.

**Indicators:**

- Explicit objective: "My goal is to..."
- Strategic constraints: "I need to consider..."
- Request for structure: "Can you outline...?"
- Meta-instruction: "Before you respond, ask me..."

**High-confidence examples:**

- "My objective is to compare two theories; give me criteria first."
- "Before I write the final version, let me map my argument."
- "I need to organize this into three sections aligned with my rubric."

**Not planning:**

- Pasting an assignment without any strategic thinking
- "Explain this to me" without context or goals
- Requesting a task without anticipating what success looks like

---

### 2. Monitoring (Performance Phase)

**Definition**: User supervises their own comprehension, progress, quality, or alignment with criteria.

**Indicators:**

- Expresses confusion: "I don't understand..."
- Detects a gap: "Something's missing here"
- Verifies accuracy: "Is this right according to...?"
- Contrasts with criteria: "Does this match the rubric?"

**High-confidence examples:**

- "I'm not sure I understand the difference; can you clarify?"
- "Revise if this meets the rubric I shared."
- "Did you use the exact text from the paper, or did you paraphrase?"

**Not monitoring:**

- Asking for more detail without checking own comprehension
- "Explain better" without identifying what's confusing
- Asking a new question unrelated to current work

---

### 3. Evaluation (Self-Reflection Phase)

**Definition**: User judges quality, utility, sufficiency, or correctness of a response or strategy.

**Indicators:**

- Value judgment: "This is too general"
- Comparison: "Which version is better?"
- Criterion-based critique: "This doesn't meet criteria X"
- Identifying strengths/weaknesses: "The argument is strong but..."

**High-confidence examples:**

- "This is too general; it doesn't respond to the rubric."
- "I like this version better because it keeps my voice."
- "This oversimplifies the theory in a risky way."

**Not evaluation:**

- "This is good" / "Perfect" (no justification)
- "I prefer this" (without explaining why it serves your goals)
- Thanking or closing the conversation

---

### 4. Adaptation (Adjustment/Next Cycle)

**Definition**: User modifies strategy, approach, criteria, or process based on monitoring or evaluation.

**Indicators:**

- Reframes the request with new constraints: "Now use..."
- Changes approach after detecting a problem: "Let me try differently"
- Adjusts restrictions: "Without jargon this time"
- Modifies the process: "Stop and ask me before..."

**High-confidence examples:**

- "This is too general; reformulate using examples from my interviews."
- "I don't like my voice in this; recover my style."
- "Don't write the final version yet; first help me verify my sources."

**Not adaptation:**

- "Make it shorter" (formatting, not strategy)
- "Continue" (no change, just continuation)
- "Another version" (without explaining what changes)

---

## Decision Rules: Avoid False Positives

This framework prioritizes **specificity over recall**: it's better to miss a regulatory behavior than to code a casual phrase as metacognition.

### The Minimum Evidence Test

To code **any phase**, the user turn must contain **at least 2 of these 3 components:**

1. **Object regulated**: What the user is controlling (understanding, source, argument, style, progress, strategy)
2. **Regulatory action**: What they do (anticipate, verify, contrast, judge, correct, decide, reorient)
3. **Criterion or consequence**: Against what or for what (rubric, source, rigor, objective, audience, coherence)

**Example: Minimum Test in Action**

Turn: "I think this is better because it has more examples."

- Object: ✓ (comparison of two versions)
- Action: ? (preference, not explicit action)
- Criterion: ✓ (has more examples)

**Result**: Only 2/3 → **Code as Evaluation** (user has object + criterion, even if action is implicit)

---

### Keyword Traps: What NOT to Code

**Lexical coincidence alone is not evidence:**

Phrases that sound regulatory but often aren't:

| Phrase | Problem | What to Look For |
|--------|---------|------------------|
| "No entiendo" (I don't understand) | Could be task confusion, not self-monitoring | Does user relate it to their own process or criteria? |
| "Perfecto" (Perfect) | Social/polite, not evaluative | Is there a reason why it's perfect? |
| "Hazlo más corto" (Make it shorter) | Formatting, not strategy | Is length tied to a goal or criterion? |
| "Otro intento" (Another try) | Might be just requesting variation | Is there a new approach or criterion? |

---

## Empirical Corrective Layers

The YAML includes three corrective layers derived from manual audits. These fix specific patterns that caused false positives:

### Layer 1: Pilot Audit (50 turns)

**Problem**: Attributing regulatory behaviors to quoted text (emails, WhatsApp) that the user didn't write.

**Solution**: Segment turno into user's own text vs. text from third party. Code only user's own actions.

### Layer 2: Second Sample (282 turns)

**Problem**: A lone edit verb + long pasted text was coded as Monitoring/Adaptation even without stated criteria.

Example: `revisa: [large academic paragraph]` — No criteria stated, just the verb.

**Solution**: Require explicit criterion or defect mentioned by the user, not just the action verb.

### Layer 3: Global Rules

**Concept vs. Opinion**: A brief reason ("I think version B has better clarity") counts as a criterion. An isolated preference ("I like this better") without object/action does not.

---

## How to Use This Framework

### For Manual Coding

1. Read the `codebook_template.yaml` to understand all categories
2. For each user turn in a conversation:
   - Identify object, action, criterion (test for minimum 2/3)
   - Check against negative rules
   - Assign phase(s) and confidence level
3. Record evidence (quote from turn)
4. Mark if human review needed

### For Automated Coding

See `codebook/tools/codify.py` — Python script that:

1. Loads conversation JSON
2. Runs against local LLM (Ollama, vLLM, etc.) with the codebook YAML as prompt
3. Generates CSV with:
   - Turno_ID
   - Phases assigned (Planificacion, Monitoreo, Evaluacion, Adaptacion)
   - Confidence (Alta, Media, Baja-Media, Baja)
   - Evidence excerpt
   - Justification
   - Requiere_Revision (Yes/No)

### Output Format

Each turn gets coded with:

```json
{
  "Conversacion_ID": "conv_001",
  "Turno_ID": 5,
  "Rol": "Usuario",
  "Texto": "No estoy seguro de que esto cumple la rubrica. Verificalo contra los criterios que envie.",
  "Planificacion": false,
  "Monitoreo": true,
  "Evaluacion": true,
  "Adaptacion": false,
  "Evidencia_Monitoreo": "User explicitly checks alignment with rubric",
  "Evidencia_Evaluacion": "User questions if output meets criteria",
  "Categorias_Autorregulacion": ["Monitoreo", "Evaluacion"],
  "Justificacion_Codificacion": "User detects potential gap between output and stated criteria",
  "Confianza": "Alta",
  "Requiere_Revision": false
}
```

---

## Adapting the Framework

### Translate to Your Language

The framework is language-agnostic. To adapt:

1. Translate linguistic patterns (regex section) to your language
2. Adjust examples to your educational context
3. Test on 20-50 turns manually first
4. Refine patterns based on hits/misses

### Extend for New Categories

Want to add a 5th category? Document:

1. Theoretical justification (where does it fit in SRL theory?)
2. Operational definition (what observable behavior?)
3. Minimum evidence test (what must appear?)
4. Linguistic patterns + examples
5. Negative rules (what is NOT this category?)
6. Validation on 30+ turns

### Use with Different LLMs

The framework works with any LLM: ChatGPT, Claude, Gemini, open-source, etc. Linguistic patterns may need tuning for very different conversation styles (e.g., Twitter vs. academic essays).

---

## Validation & Performance

**Pilot audit results** (50 conversation turns):

- False positive rate: 12% (6/50)
- High-confidence predictions: 92% accuracy (46/50)

**Second sample** (282 complex turns):

- Main error pattern: Edit verbs + pasted text without criteria (corrected in Layer 2)
- Consistency: ~95% alignment on clear cases; 70% on edge cases

The framework is **conservative by design** — it prefers to say "no self-regulation" rather than guess. This means:

- ✅ High precision (when it codes something, it's likely real)
- ⚠️ Possible recall issues (some subtle SRL may be missed)

---

## Example Walkthrough

### Conversation Excerpt

```
Turn 1 (User): 
"My assignment is to analyze how AI shapes education. 
Before I start, can you outline three competing perspectives 
I should consider?"

Turn 2 (Assistant):
"1. AI as efficiency tool...
 2. AI as pedagogical augmentation...
 3. AI as threat to critical thinking..."

Turn 3 (User):
"Good start. Now I need to check if these align with 
what my professor emphasized in class. 
He said critical thinking is the main concern—
does your framework address that risk?"

Turn 4 (Assistant):
"Yes, perspective 3 directly addresses..."

Turn 5 (User):
"Hmm, I'm not sure I agree with how you framed it. 
Let me propose a different angle: 
instead of 'threat to critical thinking,' 
frame it as 'shifts in critical thinking practices.' 
This is more nuanced and matches the theory I'm reading."
```

### Coding

| Turn | Phase | Evidence | Confidence | Notes |
|------|-------|----------|-----------|-------|
| 1 | Planificacion | User sets goal ("analyze") + requests structure ("outline") | Alta | Strategic anticipation |
| 3 | Monitoreo + Evaluacion | User contrasts output against professor's emphasis + questions framework | Alta | Monitoring (checks alignment), Evaluation (judges if it addresses concern) |
| 5 | Evaluacion + Adaptacion | User disagrees with framing + proposes new approach with justification | Alta | Evaluation (frames problem) + Adaptation (reframes using theory) |

---

## Research Applications

### Publish This Framework

If you use this for research:

```bibtex
@article{your_citation,
  title={Analyzing Self-Regulated Learning in LLM Conversations},
  author={Your Name},
  year={2026},
  url={https://github.com/josuerodriquezs-star/transcript-anáhuac/codebook}
}
```

### Replicate / Extend

Studies you could run:

- Compare SRL patterns across different LLMs
- Correlate SRL coding with learning outcomes
- Analyze SRL in different domains (STEM, humanities, professional)
- Longitudinal: does SRL in LLM chats predict academic success?
- Intervention: does training students to be more regulatory improve outcomes?

---

## Troubleshooting

### "Everything looks like planning"

**Problem**: Coding too liberally.

**Fix**: Apply the **2/3 test strictly**. If user only mentions one component, code as "No" unless it's particularly theoretically significant.

### "I keep missing subtle monitoring"

**Problem**: Monitoring is often implicit.

**Fix**: Look for verbs like "think," "wonder," "consider," "seems," "maybe" + a contrast. Example: "This seems inconsistent with the theory" = Monitoring.

### "Third-party text keeps getting coded"

**Problem**: Not segmenting correctly.

**Fix**: Separate user's own writing from quoted content (emails, messages, pasted articles). Only code user's prose.

### "Confidence is always low"

**Problem**: Too many edge cases flagged.

**Fix**: Use corrective layers more strictly. If doubt is "leve pero no afecta una inferencia importante," code as "No" (conservative default).

---

## Files in This Folder

- **`codebook_template.yaml`** — Full framework YAML (copy and adapt this)
- **`examples/`** — Sample conversations and coded outputs
  - `example_conversation.json` — Input format
  - `example_output.json` — Output format
  - `readme_examples.md` — Detailed walkthrough
- **`tools/`** — Scripts to automate coding
  - `codify.py` — Run codebook against conversations
  - `process_results.py` — Summarize results

---

## References

**Theoretical foundation:**

- Zimmerman, B. J. (2002). Becoming a self-regulated learner: An overview. *Theory Into Practice*, 41(2), 64-70.

**Related work on LLM & learning:**

- Kasneci, E., et al. (2023). ChatGPT for good? On opportunities and challenges of large language models for education. *Learning and Individual Differences*, 103, 102274.

---

## License

Apache 2.0 — Use, modify, distribute freely.

Copyright 2026 Josué Salvador Rodríguez Sánchez

---

## Questions?

- **Framework questions**: Open an issue in the repo
- **Need help adapting?**: See `examples/readme_examples.md`
- **Want to contribute?**: Fork and submit a PR with your language translation or extended categories

---

Happy analyzing! 🎓
