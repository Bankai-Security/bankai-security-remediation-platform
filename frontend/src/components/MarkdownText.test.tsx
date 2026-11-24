import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownText from './MarkdownText';

describe('MarkdownText', () => {
  it('renders headings, emphasis, code, and lists as Markdown', () => {
    render(<MarkdownText>{'# Finding\n\n**High** risk in `idna.encode()`\n\n- First\n- Second'}</MarkdownText>);
    expect(screen.getByRole('heading', { level: 1, name: 'Finding' })).toBeInTheDocument();
    expect(screen.getByText('High').tagName).toBe('STRONG');
    expect(screen.getByText('idna.encode()').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('does not turn unsafe Markdown URLs into links', () => {
    const { container } = render(<MarkdownText>{'[unsafe](javascript:alert(1)) [safe](https://example.com)\nhttps://nvd.nist.gov/vuln/detail/CVE-2019-20477;'}</MarkdownText>);
    expect(screen.getByText(/unsafe/).closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'safe' })).toHaveAttribute('href', 'https://example.com/');
    expect(screen.getByRole('link', { name: 'https://nvd.nist.gov/vuln/detail/CVE-2019-20477' })).toHaveAttribute('href', 'https://nvd.nist.gov/vuln/detail/CVE-2019-20477');
    expect(container.textContent).toContain(';');
  });
});
