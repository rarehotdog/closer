import React from 'react';
import { Camera } from 'lucide-react';

// The space when the visible set is empty (a filter with no match, or a closet with no pieces).
// Says what is empty and offers the two honest ways out: clear the filter, or add from a photo.
// Never a sample number, never a blank stage (spec §3, empty state).

interface EmptyStageProps {
  /** True when a filter is narrowing the closet; false when the closet itself holds no piece. */
  filtered: boolean;
  onClearFilter: () => void;
  onStart: () => void;
}

export const EmptyStage: React.FC<EmptyStageProps> = ({ filtered, onClearFilter, onStart }) => (
  <div className="absolute inset-0 flex items-center justify-center px-6" data-testid="empty-stage">
    <div className="max-w-sm text-center">
      <p className="font-serif text-2xl text-[#141413]">{filtered ? 'No pieces here' : 'Your closet is empty'}</p>
      <p className="text-sm text-[#57534E] mt-2">
        {filtered ? 'Nothing in this closet matches the current filter.' : 'One photo of an outfit, a rail or a closet is enough to start.'}
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        {filtered && (
          <button type="button" onClick={onClearFilter} className="px-3 py-2 text-xs font-semibold rounded-lg bg-white border border-[#E7E2DA] text-[#141413] hover:border-[#F37021]" data-testid="empty-clear-filter">
            Show all pieces
          </button>
        )}
        <button type="button" onClick={onStart} className="px-3 py-2 text-xs font-semibold rounded-lg bg-[#F37021] text-white hover:bg-[#D95D12] inline-flex items-center gap-1.5" data-testid="empty-start">
          <Camera className="w-3.5 h-3.5" aria-hidden="true" />
          Add from a photo
        </button>
      </div>
    </div>
  </div>
);
