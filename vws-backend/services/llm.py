import os
import traceback
import torch

# Override with env var VWS_LLM_MODEL if you want to swap models (e.g. "google/gemma-3-1b-it"
# for a small text-only model, or "google/gemma-3-4b-it" for the mid-size multimodal one).
DEFAULT_MODEL_ID = os.environ.get("VWS_LLM_MODEL", "google/gemma-4-E2B-it")

class LocalLLMManager:
    _instance = None
    model = None
    processor = None
    load_error: str | None = None
    model_id: str = DEFAULT_MODEL_ID

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
            cls._instance._initialize_model()
        return cls._instance

    def _initialize_model(self):
        try:
            # Gemma 3+ multimodal models are typically loaded via AutoModelForImageTextToText.
            # AutoModelForMultimodalLM exists in newer transformers but isn't the right class for
            # every Gemma variant. Try the multimodal class first, then fall back to ImageTextToText,
            # then plain CausalLM for text-only Gemma checkpoints.
            from transformers import AutoProcessor, AutoTokenizer
            print(f"Loading {self.model_id}...")

            model_classes = []
            try:
                from transformers import AutoModelForMultimodalLM
                model_classes.append(AutoModelForMultimodalLM)
            except ImportError:
                pass
            try:
                from transformers import AutoModelForImageTextToText
                model_classes.append(AutoModelForImageTextToText)
            except ImportError:
                pass
            try:
                from transformers import AutoModelForCausalLM
                model_classes.append(AutoModelForCausalLM)
            except ImportError:
                pass

            last_err: Exception | None = None
            for cls in model_classes:
                try:
                    self.model = cls.from_pretrained(self.model_id, device_map="auto")
                    print(f"Loaded model with {cls.__name__}")
                    break
                except Exception as e:
                    last_err = e
                    self.model = None
            if self.model is None:
                raise last_err if last_err else RuntimeError("No compatible AutoModel class found")

            # Multimodal checkpoints have a processor; text-only checkpoints only have a tokenizer.
            try:
                self.processor = AutoProcessor.from_pretrained(self.model_id)
            except Exception:
                self.processor = AutoTokenizer.from_pretrained(self.model_id)

            self.load_error = None
            print(f"{self.model_id} successfully loaded into memory.")
        except Exception as e:
            self.load_error = f"{type(e).__name__}: {e}"
            print(f"Error loading {self.model_id}: {self.load_error}")
            traceback.print_exc()

    def generate_rewrite_brief(self, keyword: str, page_content: str) -> str:
        if not self.model or not self.processor:
            detail = self.load_error or "no error captured — check backend startup logs"
            return (
                f"Error: AI Model `{self.model_id}` failed to load.\n\n"
                f"Reason: {detail}\n\n"
                "Common fixes:\n"
                "- Set the VWS_LLM_MODEL env var to a model you have access to "
                "(e.g. `google/gemma-3-1b-it` for text-only, `google/gemma-3-4b-it` for multimodal).\n"
                "- If the model is gated on Hugging Face, run `huggingface-cli login` with a token "
                "that has accepted the model's license.\n"
                "- For low-RAM machines, prefer the 1B or 2B variants.\n"
                "- Restart the backend after changing env vars or accepting the license."
            )
            
        import torch

        prompt_text = (
            f"You are an elite Technical SEO and Information Retrieval expert. "
            f"I am trying to re-optimize a target page to capture the keyword '{keyword}'.\n\n"
            f"Here is the parsed content of the target page:\n"
            f"'''\n{page_content}\n'''\n\n"
            f"Analyze this content relative to the target keyword. Provide an extremely actionable, highly-structured rewrite brief. "
            f"You MUST include detailed guidance on the following four areas:\n"
            f"1. **Chunking Strategies:** How should the content be structurally broken down into hierarchical sub-topics?\n"
            f"2. **Target Entity Usage:** What specific NLP entities and semantic synonyms are missing and where should they be injected?\n"
            f"3. **Semantic Triples Formulation:** Suggest 3 specific Subject-Predicate-Object knowledge-graph triples that should be explicitly stated in the text to build semantic authority.\n"
            f"4. **Information Gain Improvements:** What unique data, perspective, or net-new facts can be added to outrank generic competitor content?\n\n"
            f"Present this as a clean Markdown brief."
        )

        messages = [
            {
                "role": "user",
                "content": [{"type": "text", "text": prompt_text}],
            }
        ]

        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt"
        ).to(self.model.device)

        # 600 tokens is enough for a four-section brief while keeping CPU
        # generation under a couple of minutes. Bump VWS_REWRITE_TOKENS if you
        # want longer briefs and don't mind waiting.
        import os as _os, time as _t
        _max_new = int(_os.environ.get("VWS_REWRITE_TOKENS", "600"))
        _t0 = _t.time()
        print(f"[llm] rewrite brief: generating up to {_max_new} tokens on device={self.model.device}")
        generated_ids = self.model.generate(**inputs, max_new_tokens=_max_new)
        print(f"[llm] rewrite brief: generated in {_t.time()-_t0:.1f}s")
        generated_ids_trimmed = [
            out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
        ]
        
        output_text = self.processor.batch_decode(
            generated_ids_trimmed, 
            skip_special_tokens=True, 
            clean_up_tokenization_spaces=False
        )

        return output_text[0] if output_text else "Error: Model returned empty generation."

    def generate_view_summary(self, view_name: str, payload_text: str) -> str:
        if not self.model or not self.processor:
            detail = self.load_error or "no error captured — check backend startup logs"
            return (
                f"Error: AI Model `{self.model_id}` failed to load.\n\n"
                f"Reason: {detail}\n\n"
                "Common fixes:\n"
                "- Set the VWS_LLM_MODEL env var to a model you have access to "
                "(e.g. `google/gemma-3-1b-it` for text-only, `google/gemma-3-4b-it` for multimodal).\n"
                "- If the model is gated on Hugging Face, run `huggingface-cli login` with a token "
                "that has accepted the model's license.\n"
                "- For low-RAM machines, prefer the 1B or 2B variants.\n"
                "- Restart the backend after changing env vars or accepting the license."
            )

        prompt_text = (
            f"You are an elite Technical SEO and Information Retrieval expert reviewing the "
            f"'{view_name}' visualization. Below is the actual underlying data for this view. "
            f"Your output will be rendered in a dashboard panel for an SEO practitioner.\n\n"
            f"DATA:\n'''\n{payload_text}\n'''\n\n"
            f"Write EXACTLY 3 bullet points. Each bullet MUST follow this format:\n"
            f"* **<Short noun-phrase label>:** <One sentence that cites at least one specific "
            f"number, URL, keyword, or named entity from the DATA above.> "
            f"**Action:** <One imperative sentence naming the specific URL, keyword, page, or "
            f"link to change, and the expected effect.>\n\n"
            f"HARD RULES — violating these makes the output useless:\n"
            f"1. Cite real values from DATA in every bullet. Quote keywords verbatim, write "
            f"distance scores to 3 decimals, and reference URLs by their actual path.\n"
            f"2. Do NOT use generic SEO platitudes (e.g. \"audit your content\", \"improve "
            f"topical authority\", \"ensure semantic coherence\", \"strengthen your pillar\"). "
            f"Every claim must be testable against the data.\n"
            f"3. If a section of DATA is empty or zero, say so explicitly — never invent gaps "
            f"or risks that aren't in the data.\n"
            f"4. Order bullets by leverage: biggest risk or opportunity first.\n"
            f"5. Each bullet should fit in two short lines. No preamble, no closing summary, "
            f"no header — just the three bullets.\n"
            f"6. Write numbers as plain decimals (0.5985), not LaTeX math (\\$0.5985\\$, "
            f"\\\\(0.5985\\\\)). No dollar signs around numbers. No backslash escapes.\n"
        )

        messages = [
            {
                "role": "user",
                "content": [{"type": "text", "text": prompt_text}],
            }
        ]

        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt"
        ).to(self.model.device)

        generated_ids = self.model.generate(**inputs, max_new_tokens=600)
        generated_ids_trimmed = [
            out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
        ]

        output_text = self.processor.batch_decode(
            generated_ids_trimmed,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False
        )

        return output_text[0] if output_text else "Error: Model returned empty generation."

    def generate_site_architecture(self, clusters: list) -> str:
        if not self.model or not self.processor:
            detail = self.load_error or "no error captured — check backend startup logs"
            return (
                f"Error: AI Model `{self.model_id}` failed to load.\n\n"
                f"Reason: {detail}\n\n"
                "Common fixes:\n"
                "- Set the VWS_LLM_MODEL env var to a model you have access to "
                "(e.g. `google/gemma-3-1b-it` for text-only, `google/gemma-3-4b-it` for multimodal).\n"
                "- If the model is gated on Hugging Face, run `huggingface-cli login` with a token "
                "that has accepted the model's license.\n"
                "- For low-RAM machines, prefer the 1B or 2B variants.\n"
                "- Restart the backend after changing env vars or accepting the license."
            )

        clusters_str = ""
        for i, c in enumerate(clusters):
            clusters_str += f"Cluster {i+1}: {c}\n"

        prompt_text = (
            f"You are a Technical SEO Information Architect.\n"
            f"Based on the following semantic groupings of my website content extracted mathematically from BERTopic embeddings, "
            f"I need you to map an exact subfolder domain architecture (e.g., example.com/category/sub-category/).\n\n"
            f"Here are the semantic clusters:\n"
            f"'''\n{clusters_str}\n'''\n\n"
            f"Instruction: Output ONLY a strict, highly logical markdown hierarchical list mapping these clusters into a pure physical URL structure. "
            f"Do not write paragraphs. Output a perfectly formatted folder architecture."
        )

        messages = [
            {
                "role": "user",
                "content": [{"type": "text", "text": prompt_text}],
            }
        ]

        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt"
        ).to(self.model.device)

        generated_ids = self.model.generate(**inputs, max_new_tokens=1500)
        generated_ids_trimmed = [
            out_ids[len(in_ids):] for in_ids, out_ids in zip(inputs.input_ids, generated_ids)
        ]
        
        output_text = self.processor.batch_decode(
            generated_ids_trimmed, 
            skip_special_tokens=True, 
            clean_up_tokenization_spaces=False
        )

        return output_text[0] if output_text else "Error: Model returned empty generation."

    # -- shared generation helper -----------------------------------------
    _gen_lock = None

    def _chat_inputs(self, prompt_text: str):
        # Multimodal processors expect typed content parts; plain tokenizers
        # (text-only checkpoints) expect a string.
        is_processor = hasattr(self.processor, "image_processor") or hasattr(self.processor, "tokenizer")
        content = [{"type": "text", "text": prompt_text}] if is_processor else prompt_text
        return self.processor.apply_chat_template(
            [{"role": "user", "content": content}],
            tokenize=True, add_generation_prompt=True, return_dict=True, return_tensors="pt",
        ).to(self.model.device)

    def _generate(self, prompt_text: str, max_new_tokens: int, sample: bool = False) -> str:
        import threading
        if LocalLLMManager._gen_lock is None:
            LocalLLMManager._gen_lock = threading.Lock()
        inputs = self._chat_inputs(prompt_text)
        kwargs = {"max_new_tokens": max_new_tokens}
        if sample:
            kwargs.update(do_sample=True, temperature=0.8, top_p=0.95)
        else:
            kwargs.update(do_sample=False)
        # One generation at a time: two concurrent generate() calls on one GPU
        # model can run it out of memory.
        with LocalLLMManager._gen_lock:
            generated_ids = self.model.generate(**inputs, **kwargs)
        trimmed = [out[len(inp):] for inp, out in zip(inputs["input_ids"], generated_ids)]
        decoder = getattr(self.processor, "batch_decode", None) or self.processor.tokenizer.batch_decode
        out = decoder(trimmed, skip_special_tokens=True, clean_up_tokenization_spaces=False)
        return out[0] if out else ""

    def suggest_passage_rewrite(self, title: str, heading: str, passage: str, targets: list[dict],
                                before: str = "", after: str = "", variant: int = 0) -> dict:
        """Rewrite one passage so it answers `targets` ([{query, status}]) more directly.
        Returns {"text"} or {"error"}. The caller measures whether it actually helps."""
        if not self.model or not self.processor:
            return {"error": f"The local model `{self.model_id}` isn't loaded: {self.load_error or 'see the backend console'}. "
                             "Set VWS_LLM_MODEL to a model you can run and restart the backend."}
        qlines = "\n".join(f"- {t['query']}" + (f" (currently {t['status']})" if t.get("status") else "") for t in targets)
        ctx = ""
        if before.strip():
            ctx += f"\nThe passage right before it (for context only, don't repeat it):\n'''\n{before.strip()[:700]}\n'''\n"
        if after.strip():
            ctx += f"\nThe passage right after it (for context only, don't repeat it):\n'''\n{after.strip()[:700]}\n'''\n"
        prompt = (
            "You are editing one passage of a web page so that it answers specific search queries better. "
            "Search and AI systems retrieve pages passage by passage, so this passage has to answer the queries on its own.\n\n"
            f"Page title: {title or '(none)'}\n"
            f"Section heading: {heading or '(none)'}\n\n"
            f"Queries this passage should answer, most important first:\n{qlines}\n"
            f"{ctx}\n"
            f"The passage to rewrite:\n'''\n{passage.strip()}\n'''\n\n"
            "Rewrite the passage so it directly and explicitly answers those queries.\n"
            "Rules:\n"
            "- Keep every fact, number, name and claim that is already there. Do not invent statistics, prices, dates, quotes, clients or sources.\n"
            "- If a good answer needs a fact you don't have, write a placeholder in square brackets, like [add: typical cost range], instead of making it up.\n"
            "- Open with a sentence that answers the most important query directly, using its wording naturally.\n"
            "- Keep roughly the same length (within about 30%) and the same voice, tone and point of view.\n"
            "- Plain prose only: no headings, bullet points, markdown, preamble or explanation.\n\n"
            "Return only the rewritten passage."
        )
        words = len(passage.split())
        max_new = int(min(900, max(160, words * 2.2 + 60)))
        try:
            raw = self._generate(prompt, max_new, sample=variant > 0)
        except Exception as e:
            traceback.print_exc()
            return {"error": f"Generation failed: {type(e).__name__}: {e}"}
        return {"text": _clean_rewrite(raw)}


def _clean_rewrite(raw: str) -> str:
    """Strip the wrappers small models like to add around a rewrite."""
    import re
    t = (raw or "").strip()
    t = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", t).strip()
    t = re.sub(r"^(here(?:'s| is)[^\n:]*:|rewritten passage:|revised passage:)\s*", "", t, flags=re.I).strip()
    t = re.sub(r"^'{3}\s*|\s*'{3}$", "", t).strip()
    if len(t) > 1 and t[0] == t[-1] == '"':
        t = t[1:-1].strip()
    t = re.sub(r"^\*\*|\*\*$", "", t).strip()
    return t
