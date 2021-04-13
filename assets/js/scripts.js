//SLIDER
new BeerSlider(document.getElementById('slider'), {
  start: '50',
  prefix: 'beer'
});

$(document).ready(() => {
  $('#uploadImage').on('click', () => {
      $("#fileBrowser").trigger("click");
  });

  $('#fileBrowser').on('change', () => {
      resetImgSelection()
      resetPlayFlow()

      $('#lengthInSeconds').val('3')
      
      loadCanvas($('#fileBrowser')[0].files[0])
      $("#settings").removeClass('invisible')
      window.scrollTo(0, 300 + window.scrollY)
  });
  
//encode the image
  $('#generateButton').on('click', () => {
      showLoading()
      resetPlayFlow()
      setTimeout(() => getImageData(),100)
  });

  $('#galleryImg1').on('click', () => {
      resetImgSelection()
      $('#lengthInSeconds').val('3')
      $('#galleryImg1').addClass('img-selected')
      loadCanvasFromExampleFiles($('#galleryImg1').attr('src'))
      $("#settings").removeClass('invisible')
      window.scrollTo(0, 300 + window.scrollY);
  })

  $('#galleryImg2').on('click', () => {
      resetImgSelection()
      $('#lengthInSeconds').val('6')
      $('#galleryImg2').addClass('img-selected')
      loadCanvasFromExampleFiles($('#galleryImg2').attr('src'))
      $("#settings").removeClass('invisible')
      window.scrollTo(0, 300 + window.scrollY);
  })

  $('#galleryImg3').on('click', () => {
      resetImgSelection()
      $('#lengthInSeconds').val('5')
      $('#galleryImg3').addClass('img-selected')
      loadCanvasFromExampleFiles($('#galleryImg3').attr('src'))
      $("#settings").removeClass('invisible')
      window.scrollTo(0, 300 + window.scrollY);
  })

  function resetImgSelection() {
      $('#galleryImg1').removeClass('img-selected')
      $('#galleryImg2').removeClass('img-selected')
      $('#galleryImg3').removeClass('img-selected')
  }

  $('#play-icon').on('click', () => {
      playFlow()
  })
  $('#playButton').on('click', () => {
      playFlow()
  })

  function playFlow() {
      $('#play-icon').addClass('invisible')
      $('#playButton').addClass('invisible')
      document.getElementById('audioPlayer').play()
  }

  function resetPlayFlow() {
      $('#play-icon').removeClass('invisible')
      $('#playButton').removeClass('invisible')
      $('#previewPage').addClass('invisible')
  }

});