#!/usr/bin/env python3
"""
Codify: Apply Metacognitive Process Analysis Architecture to conversations.

This script loads a conversation JSON, sends each user turn to a local LLM,
and generates SRL coding (Planificacion, Monitoreo, Evaluacion, Adaptacion).

Usage:
    python codify.py --conversation examples/example_conversation.json \
                     --codebook codebook_template.yaml \
                     --model ollama:mistral \
                     --output results.csv

Requirements:
    - PyYAML: pip install pyyaml
    - Requests: pip install requests (if using remote LLM API)
    - Ollama running locally (if using ollama model)
"""

import json
import yaml
import argparse
import sys
from pathlib import Path
from typing import Dict, List, Optional
import csv

# Optional: LLM client (adjust based on your setup)
# For Ollama: pip install ollama
# For Claude API: pip install anthropic
# For local inference: install your preferred inference library

class MetacognitiveCoder:
    """Apply codebook to conversations."""

    def __init__(self, codebook_path: str, model_name: str):
        """
        Initialize coder with codebook and LLM.

        Args:
            codebook_path: Path to codebook_template.yaml
            model_name: Model identifier (e.g., 'ollama:mistral' or 'claude-3-sonnet')
        """
        self.codebook_path = Path(codebook_path)
        self.model_name = model_name
        self.codebook = self._load_codebook()
        self.llm = self._init_llm()

    def _load_codebook(self) -> Dict:
        """Load YAML codebook."""
        with open(self.codebook_path, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)

    def _init_llm(self):
        """Initialize LLM client based on model_name."""
        if self.model_name.startswith('ollama:'):
            try:
                import ollama
                return ollama.Client(host='http://localhost:11434')
            except ImportError:
                print("ERROR: ollama package not found. Install with: pip install ollama")
                sys.exit(1)
        elif self.model_name.startswith('claude'):
            try:
                from anthropic import Anthropic
                return Anthropic()
            except ImportError:
                print("ERROR: anthropic package not found. Install with: pip install anthropic")
                sys.exit(1)
        else:
            print(f"ERROR: Model {self.model_name} not supported.")
            sys.exit(1)

    def _build_prompt(self, turno: Dict) -> str:
        """Build prompt for LLM to code a turn."""
        texto = turno.get('Texto', '')

        prompt = f"""You are a qualitative coding expert. Using the Metacognitive Process Analysis Architecture codebook,
analyze the following user turn from an LLM conversation and assign SRL codes.

CODEBOOK SUMMARY:
- Planificacion: User anticipates, organizes, or defines task approach beforehand
- Monitoreo: User supervises comprehension, progress, or quality
- Evaluacion: User judges quality or utility against criteria
- Adaptacion: User modifies strategy/approach based on feedback

MINIMUM EVIDENCE TEST: Assign a code only if 2+ of these are present:
1. Objeto regulado (what user controls)
2. Accion reguladora (what user does)
3. Criterio o consecuencia (against what/for what)

USER TURN:
"{texto}"

INSTRUCTIONS:
1. Identify which phases apply (Planificacion, Monitoreo, Evaluacion, Adaptacion)
2. For each phase, quote brief evidence from the text
3. Rate confidence: Alta, Media, Media-Alta, Baja-Media, Baja
4. Explain your justification

RESPOND IN JSON FORMAT ONLY:
{{
  "Planificacion": {true/false},
  "Monitoreo": {true/false},
  "Evaluacion": {true/false},
  "Adaptacion": {true/false},
  "Evidencia_Planificacion": "quote or description",
  "Evidencia_Monitoreo": "quote or description",
  "Evidencia_Evaluacion": "quote or description",
  "Evidencia_Adaptacion": "quote or description",
  "Categorias_Autorregulacion": ["list", "of", "assigned", "phases"],
  "Confianza": "Alta/Media/Baja-Media",
  "Justificacion_Codificacion": "brief explanation",
  "Requiere_Revision": false
}}
"""
        return prompt

    def _call_llm(self, prompt: str) -> Dict:
        """Send prompt to LLM and parse response."""
        try:
            if self.model_name.startswith('ollama:'):
                model = self.model_name.split(':')[1]
                response = self.llm.generate(
                    model=model,
                    prompt=prompt,
                    stream=False
                )
                response_text = response.get('response', '')
            elif self.model_name.startswith('claude'):
                response = self.llm.messages.create(
                    model=self.model_name,
                    max_tokens=1024,
                    messages=[{"role": "user", "content": prompt}]
                )
                response_text = response.content[0].text

            # Extract JSON from response
            import re
            json_match = re.search(r'\{.*\}', response_text, re.DOTALL)
            if json_match:
                return json.loads(json_match.group())
            else:
                print(f"WARNING: Could not parse JSON from response: {response_text}")
                return self._default_response()

        except Exception as e:
            print(f"ERROR calling LLM: {e}")
            return self._default_response()

    def _default_response(self) -> Dict:
        """Return safe default response."""
        return {
            "Planificacion": False,
            "Monitoreo": False,
            "Evaluacion": False,
            "Adaptacion": False,
            "Evidencia_Planificacion": "",
            "Evidencia_Monitoreo": "",
            "Evidencia_Evaluacion": "",
            "Evidencia_Adaptacion": "",
            "Categorias_Autorregulacion": [],
            "Confianza": "Baja",
            "Justificacion_Codificacion": "Could not parse LLM response",
            "Requiere_Revision": True
        }

    def code_conversation(self, conversation_path: str) -> List[Dict]:
        """
        Code all user turns in a conversation.

        Args:
            conversation_path: Path to conversation JSON

        Returns:
            List of coded turns
        """
        with open(conversation_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        conv_id = data.get('Conversacion_ID', 'unknown')
        turnos = data.get('turnos', [])

        results = []

        for turno in turnos:
            if turno.get('Rol') != 'Usuario':
                continue  # Only code user turns

            turno_id = turno.get('Turno_ID')
            print(f"Coding turn {turno_id}...", file=sys.stderr)

            # Build and send prompt
            prompt = self._build_prompt(turno)
            coding = self._call_llm(prompt)

            # Add metadata
            coding.update({
                "Conversacion_ID": conv_id,
                "Turno_ID": turno_id,
                "Rol": "Usuario",
                "Texto_Resumen": turno.get('Texto', '')[:100] + "..."
            })

            results.append(coding)

        return results

    def save_results(self, results: List[Dict], output_path: str) -> None:
        """Save results to CSV."""
        if not results:
            print("ERROR: No results to save.")
            return

        keys = list(results[0].keys())

        with open(output_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=keys)
            writer.writeheader()
            writer.writerows(results)

        print(f"Results saved to {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Apply Metacognitive Process Analysis to conversations"
    )
    parser.add_argument('--conversation', required=True, help='Path to conversation JSON')
    parser.add_argument('--codebook', required=True, help='Path to codebook YAML')
    parser.add_argument('--model', required=True, help='LLM to use (e.g., ollama:mistral, claude-3-sonnet)')
    parser.add_argument('--output', required=True, help='Output CSV file')

    args = parser.parse_args()

    # Check files exist
    if not Path(args.conversation).exists():
        print(f"ERROR: Conversation file not found: {args.conversation}")
        sys.exit(1)
    if not Path(args.codebook).exists():
        print(f"ERROR: Codebook file not found: {args.codebook}")
        sys.exit(1)

    # Initialize coder
    print("Initializing coder...", file=sys.stderr)
    coder = MetacognitiveCoder(args.codebook, args.model)

    # Code conversation
    print("Coding conversation...", file=sys.stderr)
    results = coder.code_conversation(args.conversation)

    # Save results
    coder.save_results(results, args.output)

    print(f"Processed {len(results)} turns")


if __name__ == '__main__':
    main()
