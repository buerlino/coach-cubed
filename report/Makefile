# coach report. `make` -> report.pdf; needs texlive (see README.md).
#
# Two pdflatex passes, always: the first writes .aux with the \bibitem labels,
# the second resolves the \cite keys against it. One pass leaves "[?]" in the
# text and exits 0, so the failure is silent.
TEX   := pdflatex
FLAGS := -interaction=nonstopmode -halt-on-error

report.pdf: report.tex
	$(TEX) $(FLAGS) report.tex
	$(TEX) $(FLAGS) report.tex

clean:
	rm -f report.aux report.log report.out report.toc

distclean: clean
	rm -f report.pdf

.PHONY: clean distclean
