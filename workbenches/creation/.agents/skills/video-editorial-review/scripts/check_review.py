#!/usr/bin/env python3
"""Revision guard only: never a semantic reviewer or publication permission."""
import argparse
import hashlib
import json
from pathlib import Path

SURFACES = {
    'evidence': {'claims', 'sources', 'calculations'},
    'architecture': {'script', 'key-pages', 'timing'},
    'hook': {'opening-script', 'opening-timing', 'proof'},
    'package': {'cover', 'thumbnail', 'title', 'opening-script'},
    'sample': {'sample-video', 'audio', 'motion'},
    'final': {'final-video', 'audio', 'captions', 'synchronization'},
    'release': {'final-video', 'package', 'platform-preview', 'open-issues'},
    'learning': {'analytics', 'version', 'observation-window'},
}


def check(review, stage, author_id):
    errors = []
    if not isinstance(review, dict):
        return ['Review must be an object']
    if review.get('stage') != stage:
        errors.append('Review stage does not match requested stage')
    if review.get('decision') != 'pass':
        errors.append('Review decision is not pass')
    reviewer = review.get('reviewer_id')
    if not isinstance(reviewer, str) or not reviewer.strip() or reviewer == author_id:
        errors.append('Independent reviewer identity is absent or equals author')
    for field in ('native_record', 'allowed_next_action'):
        if not isinstance(review.get(field), str) or not review[field].strip():
            errors.append(f'Missing {field}')
    surfaces = review.get('surfaces')
    if not isinstance(surfaces, list) or not all(isinstance(x, str) for x in surfaces):
        errors.append('surfaces must be a list of names')
    else:
        missing = SURFACES[stage] - set(surfaces)
        if missing:
            errors.append('Required surfaces not recorded: ' + ', '.join(sorted(missing)))
    if not isinstance(review.get('unchecked'), list):
        errors.append('unchecked must explicitly record limitations as a list')
    findings = review.get('findings')
    if not isinstance(findings, list):
        errors.append('findings must be a list')
    else:
        for i, finding in enumerate(findings):
            if not isinstance(finding, dict):
                errors.append(f'Finding {i} must be an object')
                continue
            if finding.get('severity') not in ('blocking', 'non-blocking'):
                errors.append(f'Finding {i} has unknown severity')
            if finding.get('severity') == 'blocking' and finding.get('resolved') is not True:
                errors.append(f'Finding {i} still blocks this stage')
            for field in ('location', 'evidence', 'impact', 'fix', 'recheck'):
                if not isinstance(finding.get(field), str) or not finding[field].strip():
                    errors.append(f'Finding {i} missing {field}')
    inputs = review.get('inputs')
    if not isinstance(inputs, list) or not inputs:
        errors.append('No reviewed inputs')
    else:
        for i, item in enumerate(inputs):
            if not isinstance(item, dict) or not isinstance(item.get('path'), str):
                errors.append(f'Input {i} missing path')
                continue
            path = Path(item['path'])
            if not path.is_absolute() or not path.is_file():
                errors.append(f'Input {i} is not an existing absolute file')
                continue
            try:
                digest = hashlib.sha256()
                with path.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                if digest.hexdigest() != item.get('sha256'):
                    errors.append(f'Input changed after review: {path}')
            except OSError as exc:
                errors.append(f'Cannot read input {i}: {exc}')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('review', type=Path)
    parser.add_argument('--stage', required=True, choices=SURFACES)
    parser.add_argument('--author-id', required=True)
    args = parser.parse_args()
    try:
        errors = check(json.loads(args.review.read_text()), args.stage, args.author_id)
    except (OSError, ValueError) as exc:
        errors = [str(exc)]
    print(json.dumps({'revision_guard': 'refused' if errors else 'pass', 'errors': errors,
                      'scope': 'Recorded identity, scope and file revisions only; no semantic or authorization proof'}, ensure_ascii=False))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
