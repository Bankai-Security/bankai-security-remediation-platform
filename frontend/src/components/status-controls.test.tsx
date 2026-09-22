import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CiStatusCircle from './CiStatusCircle';
import RetryCiButton from './RetryCiButton';

describe('pipeline status controls', () => {
  it.each([
    ['queued', 'CI verification queued'],
    ['running', 'CI verification running'],
    ['passed', 'CI verification passed'],
    ['failed', 'CI verification failed'],
  ] as const)('renders the %s status', (status, label) => {
    render(<CiStatusCircle status={status} runUrl={null} />);
    expect(screen.getByTitle(label)).toBeInTheDocument();
  });

  it('links a status to its run without leaking opener access', () => {
    render(<CiStatusCircle status="failed" runUrl="https://ci.example/run/1" error="Security gate failed" />);
    const link = screen.getByTitle('Security gate failed');
    expect(link).toHaveAttribute('href', 'https://ci.example/run/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('does not render an unset status', () => {
    const { container } = render(<CiStatusCircle status={null} runUrl={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('runs retry once and disables it while a retry is active', () => {
    const retry = vi.fn();
    const { rerender } = render(<RetryCiButton onClick={retry} retrying={false} title="Retry CI" />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry CI' }));
    expect(retry).toHaveBeenCalledOnce();

    rerender(<RetryCiButton onClick={retry} retrying title="Retrying CI" />);
    expect(screen.getByRole('button', { name: 'Retrying CI' })).toBeDisabled();
  });
});
