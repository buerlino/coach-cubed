# coach report. `make` -> report.pdf; needs texlive (see README.md).
#
# Two pdflatex passes, always: the first writes .aux with the \bibitem labels,
# the second resolves the \cite keys against it. One pass leaves "[?]" in the
# text and exits 0, so the failure is silent.
TEX   := pdflatex
FLAGS := -interaction=nonstopmode -halt-on-error

FIGS := $(wildcard figures/*.pdf)

report.pdf: report.tex $(FIGS)
	$(TEX) $(FLAGS) report.tex
	$(TEX) $(FLAGS) report.tex

# figures come from the notebook; `make figures` re-executes it (numpy +
# matplotlib only, unless the track cache is missing — see README.md)
figures: analysis.ipynb
	jupyter nbconvert --to notebook --execute --inplace analysis.ipynb

clean:
	rm -f report.aux report.log report.out report.toc

distclean: clean
	rm -f report.pdf

.PHONY: figures clean distclean
